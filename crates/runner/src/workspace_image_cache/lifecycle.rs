use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use nix::fcntl::Flock;
use tokio::fs;
#[cfg(test)]
use tracing::debug;
use tracing::{info, warn};

use crate::error::{RunnerError, RunnerResult};
use crate::ids::RunId;
use crate::storage_fingerprints::StorageFingerprints;
use crate::types::{HeldSessionState, MAX_HELD_SESSION_STATES};

use super::entry::is_cache_key_name;
use super::fs::{
    allocated_bytes, ensure_workspace_cache_entry_dir, has_copy_headroom, local_timestamp,
    remove_non_directory_workspace_cache_entry, remove_workspace_cache_path_if_exists, sparse_copy,
};
use super::metadata::{
    WorkspaceCacheMetadata, WorkspaceCacheState, WorkspaceImageFileIdentity, WorkspaceTrust,
};
use super::path_safety::{
    filter_storage_fingerprints_for_working_dir, is_safe_guest_working_dir,
    normalize_safe_guest_working_dir,
};
use super::types::{
    CacheBudget, WorkspaceCacheCheckoutResult, WorkspaceCacheTerminalStatus,
    WorkspaceImageActiveLeaseRequest, WorkspaceImageLeaseIdentity, WorkspaceImagePrepareRequest,
    WorkspaceImagePromotionRequest,
};
use super::{
    CACHE_FORMAT_VERSION, CACHE_KEY_VERSION, SessionWorkspaceCache, WORKSPACE_DRIVE_LAYOUT,
};

pub(crate) struct WorkspaceImageLease {
    cache: SessionWorkspaceCache,
    pub(super) cache_key: Option<String>,
    profile_name: String,
    cli_agent_session_id: Option<String>,
    working_dir: String,
    active_image: PathBuf,
    pub(super) source_image: Option<PathBuf>,
    pub(super) consumed_cache_hit: bool,
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
    cli_agent_session_id: String,
    working_dir: String,
    active_image: PathBuf,
    image_size_bytes: u64,
    consumed_cache_hit: bool,
    terminal_status: WorkspaceCacheTerminalStatus,
    completed_at: String,
    storage_fingerprints: StorageFingerprints,
}

struct WorkspaceImagePromotionInput<'a> {
    run_id: RunId,
    cache_key: &'a str,
    profile_name: &'a str,
    cli_agent_session_id: &'a str,
    working_dir: &'a str,
    active_image: &'a Path,
    image_size_bytes: u64,
    terminal_status: WorkspaceCacheTerminalStatus,
    completed_at: &'a str,
    storage_fingerprints: &'a StorageFingerprints,
}

struct WorkspaceImageLeaseCommon<'a> {
    run_id: RunId,
    profile_name: &'a str,
    cli_agent_session_id: Option<&'a str>,
    raw_working_dir: &'a str,
    normalized_working_dir: Option<String>,
    active_image: PathBuf,
    image_size_bytes: u64,
}

struct WorkspaceImageLeaseBase {
    cache: SessionWorkspaceCache,
    profile_name: String,
    cli_agent_session_id: Option<String>,
    working_dir: String,
    active_image: PathBuf,
    image_size_bytes: u64,
}

struct WorkspaceImageLeaseState {
    cache_key: Option<String>,
    source_image: Option<PathBuf>,
    consumed_cache_hit: bool,
    previous_storage: Option<StorageFingerprints>,
    entry_lock: Option<Flock<std::fs::File>>,
    workspace_drive_enabled: bool,
    result: WorkspaceCacheCheckoutResult,
}

fn workspace_image_size_mb(image_size_bytes: u64) -> u32 {
    let mib = 1024 * 1024;
    image_size_bytes.div_ceil(mib).min(u64::from(u32::MAX)) as u32
}

impl<'a> WorkspaceImageLeaseCommon<'a> {
    fn new(cache: &SessionWorkspaceCache, identity: WorkspaceImageLeaseIdentity<'a>) -> Self {
        Self {
            run_id: identity.run_id,
            profile_name: identity.profile_name,
            cli_agent_session_id: identity.cli_agent_session_id,
            raw_working_dir: identity.working_dir,
            normalized_working_dir: normalize_safe_guest_working_dir(identity.working_dir),
            active_image: cache.paths().active_workspace_image(&identity.sandbox_id),
            image_size_bytes: identity.image_size_bytes,
        }
    }

    fn safe_working_dir(&self) -> Option<&str> {
        self.normalized_working_dir.as_deref()
    }

    fn lease_working_dir(&self) -> &str {
        self.safe_working_dir().unwrap_or(self.raw_working_dir)
    }

    fn cache_key(
        &self,
        cache: &SessionWorkspaceCache,
        cli_agent_session_id: &str,
        working_dir: &str,
    ) -> String {
        cache.scoped_cache_key(
            self.profile_name,
            cli_agent_session_id,
            working_dir,
            self.image_size_bytes,
        )
    }

    fn lease_base(&self, cache: &SessionWorkspaceCache) -> WorkspaceImageLeaseBase {
        WorkspaceImageLeaseBase {
            cache: cache.clone(),
            profile_name: self.profile_name.to_owned(),
            cli_agent_session_id: self.cli_agent_session_id.map(str::to_owned),
            working_dir: self.lease_working_dir().to_owned(),
            active_image: self.active_image.clone(),
            image_size_bytes: self.image_size_bytes,
        }
    }
}

impl WorkspaceImageLease {
    fn from_parts(base: WorkspaceImageLeaseBase, state: WorkspaceImageLeaseState) -> Self {
        Self {
            cache: base.cache,
            cache_key: state.cache_key,
            profile_name: base.profile_name,
            cli_agent_session_id: base.cli_agent_session_id,
            working_dir: base.working_dir,
            active_image: base.active_image,
            source_image: state.source_image,
            consumed_cache_hit: state.consumed_cache_hit,
            image_size_bytes: base.image_size_bytes,
            workspace_drive_enabled: state.workspace_drive_enabled,
            result: state.result,
            previous_storage: state.previous_storage,
            entry_lock: state.entry_lock,
        }
    }
}

impl SessionWorkspaceCache {
    pub(crate) async fn lease_active(
        &self,
        request: WorkspaceImageActiveLeaseRequest<'_>,
    ) -> WorkspaceImageLease {
        let common = WorkspaceImageLeaseCommon::new(self, request.identity);
        let active_lease = |result, entry_lock, cache_key| {
            WorkspaceImageLease::from_parts(
                common.lease_base(self),
                WorkspaceImageLeaseState {
                    cache_key,
                    source_image: None,
                    consumed_cache_hit: false,
                    previous_storage: None,
                    entry_lock,
                    workspace_drive_enabled: request.workspace_drive_available,
                    result,
                },
            )
        };

        let Some(working_dir) = common.safe_working_dir() else {
            warn!(
                run_id = %common.run_id,
                working_dir = %common.raw_working_dir,
                "workspace image cache active lease disabled for unsafe working directory"
            );
            return active_lease(WorkspaceCacheCheckoutResult::InvalidWorkingDir, None, None);
        };
        let Some(cli_agent_session_id) = common.cli_agent_session_id else {
            return active_lease(WorkspaceCacheCheckoutResult::NoSession, None, None);
        };

        let cache_key = common.cache_key(self, cli_agent_session_id, working_dir);
        match crate::lock::try_acquire(self.entry_lock_path(&cache_key)).await {
            Ok(lock) => active_lease(
                WorkspaceCacheCheckoutResult::Miss,
                Some(lock),
                Some(cache_key),
            ),
            Err(e) => {
                info!(
                    run_id = %common.run_id,
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
        let common = WorkspaceImageLeaseCommon::new(self, request.identity);
        let workspace_drive = |result,
                               source_image: Option<PathBuf>,
                               previous_storage: Option<StorageFingerprints>,
                               entry_lock,
                               cache_key,
                               workspace_drive_enabled| {
            let consumed_cache_hit =
                result == WorkspaceCacheCheckoutResult::Hit && source_image.is_some();
            WorkspaceImageLease::from_parts(
                common.lease_base(self),
                WorkspaceImageLeaseState {
                    cache_key,
                    source_image,
                    consumed_cache_hit,
                    previous_storage,
                    entry_lock,
                    workspace_drive_enabled,
                    result,
                },
            )
        };

        let Some(working_dir) = common.safe_working_dir() else {
            warn!(
                run_id = %common.run_id,
                working_dir = %common.raw_working_dir,
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
        let Some(cli_agent_session_id) = common.cli_agent_session_id else {
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
                run_id = %common.run_id,
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
                        run_id = %common.run_id,
                        error = %e,
                        "workspace image cache stats refresh failed after GC"
                    ),
                },
                Ok(_) => {}
                Err(e) => warn!(
                    run_id = %common.run_id,
                    error = %e,
                    "workspace image cache GC failed before checkout"
                ),
            }
        }
        if stats.available_bytes < budget.min_free_bytes {
            info!(
                run_id = %common.run_id,
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

        let cache_key = common.cache_key(self, cli_agent_session_id, working_dir);
        let lock_path = self.entry_lock_path(&cache_key);
        let lock = match crate::lock::try_acquire(lock_path).await {
            Ok(lock) => lock,
            Err(e) => {
                info!(
                    run_id = %common.run_id,
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
                    run_id = %common.run_id,
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
                    run_id = %common.run_id,
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
                common.profile_name,
                cli_agent_session_id,
                working_dir,
                common.image_size_bytes,
            )
            .await
        {
            Ok(Some(metadata)) => {
                let previous = metadata.storage_fingerprints.clone();
                match fs::remove_file(&metadata_path).await {
                    Ok(()) => {
                        info!(
                            run_id = %common.run_id,
                            cache_key,
                            "workspace image cache hit checked out with move seed"
                        );
                    }
                    Err(e) => {
                        warn!(
                            run_id = %common.run_id,
                            cache_key,
                            error = %e,
                            "failed to remove workspace image cache metadata before move checkout; using fresh workspace image"
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
                }
                Some((current_path, previous))
            }
            Ok(None) => None,
            Err(e) => {
                warn!(
                    run_id = %common.run_id,
                    cache_key,
                    error = %e,
                    "workspace image cache metadata invalid; using fresh workspace image"
                );
                let entry_dir = self.session_workspace_cache_entry_dir(&cache_key);
                match fs::remove_dir_all(&entry_dir).await {
                    Ok(()) => {
                        info!(
                            run_id = %common.run_id,
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
                            run_id = %common.run_id,
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

    async fn invalidate_cache_entry(
        &self,
        run_id: RunId,
        cache_key: &str,
        reason: &str,
    ) -> RunnerResult<bool> {
        let entry_dir = self.session_workspace_cache_entry_dir(cache_key);
        match remove_workspace_cache_path_if_exists(&entry_dir).await {
            Ok(removed) => {
                if removed {
                    info!(
                        run_id = %run_id,
                        cache_key,
                        reason,
                        "workspace image cache entry invalidated"
                    );
                }
                Ok(removed)
            }
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
                input.cli_agent_session_id,
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

        let _capacity_lock = match crate::lock::try_acquire_or_busy(self.capacity_lock_path()).await
        {
            Ok(crate::lock::TryLock::Acquired(lock)) => lock,
            Ok(crate::lock::TryLock::Busy) => {
                info!(
                    run_id = %input.run_id,
                    cache_key = input.cache_key,
                    "workspace image cache promotion skipped: capacity lock busy"
                );
                return Ok(false);
            }
            Err(e) => {
                warn!(
                    run_id = %input.run_id,
                    cache_key = input.cache_key,
                    error = %e,
                    "workspace image cache promotion skipped: capacity lock unavailable"
                );
                return Ok(false);
            }
        };

        let mut stats = self.fs_stats().await?;
        let mut budget = CacheBudget::from_fs_stats(stats);
        if stats.available_bytes < budget.min_free_bytes {
            match self.gc_locked(false).await {
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
            match self.gc_locked(false).await {
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
            session_id: input.cli_agent_session_id.to_owned(),
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
        if let Err(e) = self.gc_locked(false).await {
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
                seed_image: self.source_image.as_ref().map(|source_image| {
                    if self.consumed_cache_hit {
                        sandbox::WorkspaceDriveSeedImage::Move(source_image.clone())
                    } else {
                        sandbox::WorkspaceDriveSeedImage::Copy(source_image.clone())
                    }
                }),
            })
    }

    pub(crate) fn can_attempt_promotion(
        &self,
        cli_agent_session_id_override: Option<&str>,
    ) -> bool {
        if !self.workspace_drive_enabled || !is_safe_guest_working_dir(&self.working_dir) {
            return false;
        }

        match self.result {
            WorkspaceCacheCheckoutResult::Hit | WorkspaceCacheCheckoutResult::Miss => {
                self.cache_key.is_some() && self.cli_agent_session_id.is_some()
            }
            WorkspaceCacheCheckoutResult::NoSession => {
                self.cli_agent_session_id.is_none() && cli_agent_session_id_override.is_some()
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
        if self.consumed_cache_hit {
            return self
                .cache
                .invalidate_cache_entry(run_id, cache_key, reason)
                .await;
        }
        let current = self.cache.session_workspace_cache_current_image(cache_key);
        self.cache
            .invalidate_current_image(run_id, cache_key, &current, reason)
            .await
    }

    #[cfg(test)]
    pub(crate) async fn promote(
        &self,
        run_id: RunId,
        cli_agent_session_id_override: Option<&str>,
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
        if !self.can_attempt_promotion(cli_agent_session_id_override) {
            debug!(
                run_id = %run_id,
                checkout_result = ?self.result,
                "workspace image cache promotion skipped: checkout result is not promotable"
            );
            return Ok(false);
        }

        let mut _late_entry_lock_guard = None;
        let late_cache_key;
        let (cache_key, cli_agent_session_id) = if let Some(cache_key) = self.cache_key.as_deref() {
            let Some(cli_agent_session_id) = self.cli_agent_session_id.as_deref() else {
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
            (cache_key, cli_agent_session_id)
        } else if self.cli_agent_session_id.is_none() {
            let Some(cli_agent_session_id) = cli_agent_session_id_override else {
                debug!(run_id = %run_id, "workspace image cache promotion skipped: no session id");
                return Ok(false);
            };
            late_cache_key = self.cache.scoped_cache_key(
                &self.profile_name,
                cli_agent_session_id,
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
            (late_cache_key.as_str(), cli_agent_session_id)
        } else {
            debug!(run_id = %run_id, "workspace image cache promotion skipped: no cache key");
            return Ok(false);
        };

        self.cache
            .promote_locked(WorkspaceImagePromotionInput {
                run_id,
                cache_key,
                profile_name: &self.profile_name,
                cli_agent_session_id,
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

        let cli_agent_session_id = match self.result {
            WorkspaceCacheCheckoutResult::Hit | WorkspaceCacheCheckoutResult::Miss => {
                self.cli_agent_session_id.clone()?
            }
            WorkspaceCacheCheckoutResult::NoSession => {
                request.cli_agent_session_id_override?.to_owned()
            }
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
                &cli_agent_session_id,
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
            cli_agent_session_id,
            working_dir: self.working_dir.clone(),
            active_image: self.active_image.clone(),
            image_size_bytes: self.image_size_bytes,
            consumed_cache_hit: self.consumed_cache_hit,
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

    pub(crate) fn cli_agent_session_id(&self) -> &str {
        &self.cli_agent_session_id
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
                cli_agent_session_id: &self.cli_agent_session_id,
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
            consumed_cache_hit,
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
        if consumed_cache_hit {
            return cache
                .invalidate_cache_entry(run_id, &cache_key, reason)
                .await;
        }
        let current = cache.session_workspace_cache_current_image(&cache_key);
        cache
            .invalidate_current_image(run_id, &cache_key, &current, reason)
            .await
    }

    pub(crate) fn into_active_lease(self, workspace_drive_available: bool) -> WorkspaceImageLease {
        let Self {
            cache,
            cache_key,
            entry_lock,
            run_id: _,
            sandbox_id: _,
            profile_name,
            cli_agent_session_id,
            working_dir,
            active_image,
            image_size_bytes,
            consumed_cache_hit,
            terminal_status: _,
            completed_at: _,
            storage_fingerprints: _,
        } = self;
        let base = WorkspaceImageLeaseBase {
            cache,
            profile_name,
            cli_agent_session_id: Some(cli_agent_session_id),
            working_dir,
            active_image,
            image_size_bytes,
        };
        WorkspaceImageLease::from_parts(
            base,
            WorkspaceImageLeaseState {
                cache_key: Some(cache_key),
                source_image: None,
                consumed_cache_hit,
                previous_storage: None,
                entry_lock,
                workspace_drive_enabled: workspace_drive_available,
                result: WorkspaceCacheCheckoutResult::Miss,
            },
        )
    }
}

pub(super) fn cap_workspace_held_session_states(
    states: Vec<HeldSessionState>,
) -> Vec<HeldSessionState> {
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
