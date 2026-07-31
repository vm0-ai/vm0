use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use nix::fcntl::Flock;
use tokio::fs;
#[cfg(test)]
use tracing::debug;
use tracing::{info, warn};

use crate::duration::duration_ms;
use crate::error::{RunnerError, RunnerResult};
use crate::ids::RunId;
use crate::storage_fingerprints::StorageFingerprints;
use crate::types::{
    HeldWorkspaceState, MAX_HELD_WORKSPACE_STATES, MAX_WORKSPACE_CACHES_PER_HEARTBEAT,
    MAX_WORKSPACE_CACHES_PER_REUSE_KEY, WORKSPACE_AFFINITY_VERSION, WorkspaceCacheState,
};

use super::entry::is_cache_key_name;
use super::fs::{
    allocated_bytes, ensure_workspace_cache_entry_dir, has_copy_headroom, local_timestamp,
    remove_non_directory_workspace_cache_entry, remove_workspace_cache_path_if_exists, sparse_copy,
};
use super::metadata::{
    WorkspaceCacheMetadata, WorkspaceCacheState as WorkspaceCacheEntryState,
    WorkspaceImageFileIdentity, WorkspaceTrust,
};
use super::path_safety::{
    filter_storage_fingerprints_for_working_dir, is_safe_guest_working_dir,
    normalize_safe_guest_working_dir,
};
use super::types::{
    CacheBudget, WorkspaceCacheCheckoutResult, WorkspaceCacheTerminalStatus,
    WorkspaceImageActiveLeaseRequest, WorkspaceImageLeaseIdentity, WorkspaceImagePrepareRequest,
    WorkspaceImagePromotionIdentity, WorkspaceImagePromotionIdentityMismatch,
    WorkspaceImagePromotionIdentityRequest, WorkspaceImagePromotionRequest,
    WorkspaceSessionHistorySidecar, WorkspaceSessionHistorySidecarMiss,
    WorkspaceSessionHistorySidecarPromotionSource, WorkspaceSessionHistorySidecarPublication,
};
use super::{
    CACHE_FORMAT_VERSION, CACHE_KEY_VERSION, SessionWorkspaceCache, WORKSPACE_DRIVE_LAYOUT,
};

pub(crate) struct WorkspaceImageLease {
    cache: SessionWorkspaceCache,
    pub(super) cache_key: Option<String>,
    profile_name: String,
    reuse_key: Option<String>,
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
    reuse_key: String,
    cli_agent_session_id: Option<String>,
    working_dir: String,
    active_image: PathBuf,
    image_size_bytes: u64,
    consumed_cache_hit: bool,
    terminal_status: WorkspaceCacheTerminalStatus,
    completed_at: String,
    storage_fingerprints: StorageFingerprints,
    restored_session_identity: Option<crate::restored_session_identity::RestoredSessionIdentity>,
}

pub(crate) struct WorkspaceSessionHistorySidecarEntryGuard {
    cache: SessionWorkspaceCache,
    cache_key: String,
    run_id: RunId,
    restored_session_identity: crate::restored_session_identity::RestoredSessionIdentity,
    _late_entry_lock: Option<Flock<std::fs::File>>,
}

pub(crate) struct WorkspaceImagePromotionIdentityFailure {
    pub(crate) promotion: WorkspaceImagePromotionContext,
    pub(crate) mismatch: WorkspaceImagePromotionIdentityMismatch,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WorkspaceImagePromotionOutcome {
    Promoted,
    PreservedExisting,
    SkippedUnpublished,
}

struct WorkspaceImagePromotionInput<'a> {
    run_id: RunId,
    cache_key: &'a str,
    profile_name: &'a str,
    reuse_key: &'a str,
    cli_agent_session_id: Option<&'a str>,
    working_dir: &'a str,
    active_image: &'a Path,
    image_size_bytes: u64,
    terminal_status: WorkspaceCacheTerminalStatus,
    completed_at: &'a str,
    storage_fingerprints: &'a StorageFingerprints,
    session_history_sidecar: WorkspaceSessionHistorySidecarPublication<'a>,
}

struct WorkspaceImagePromotionTarget {
    cache_key: String,
    reuse_key: String,
    cli_agent_session_id: Option<String>,
}

struct WorkspaceImageLeaseCommon<'a> {
    run_id: RunId,
    profile_name: &'a str,
    reuse_key: Option<&'a str>,
    cli_agent_session_id: Option<&'a str>,
    raw_working_dir: &'a str,
    normalized_working_dir: Option<String>,
    active_image: PathBuf,
    image_size_bytes: u64,
}

struct WorkspaceImageLeaseBase {
    cache: SessionWorkspaceCache,
    profile_name: String,
    reuse_key: Option<String>,
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
            reuse_key: identity.reuse_key,
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
        reuse_key: &str,
        working_dir: &str,
    ) -> String {
        cache.scoped_cache_key(
            self.profile_name,
            reuse_key,
            working_dir,
            self.image_size_bytes,
        )
    }

    fn lease_base(&self, cache: &SessionWorkspaceCache) -> WorkspaceImageLeaseBase {
        WorkspaceImageLeaseBase {
            cache: cache.clone(),
            profile_name: self.profile_name.to_owned(),
            reuse_key: self.reuse_key.map(str::to_owned),
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
            reuse_key: base.reuse_key,
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
    pub(crate) fn expected_promotion_identity(
        &self,
        request: WorkspaceImagePromotionIdentityRequest<'_>,
    ) -> Result<WorkspaceImagePromotionIdentity, WorkspaceImagePromotionIdentityMismatch> {
        let Some(working_dir) = normalize_safe_guest_working_dir(request.working_dir) else {
            return Err(WorkspaceImagePromotionIdentityMismatch::UnsafeWorkingDir);
        };
        let cache_key = self.scoped_cache_key(
            request.profile_name,
            request.reuse_key,
            &working_dir,
            request.image_size_bytes,
        );

        Ok(WorkspaceImagePromotionIdentity {
            sandbox_id: request.sandbox_id,
            profile_name: request.profile_name.to_owned(),
            reuse_key: request.reuse_key.to_owned(),
            working_dir,
            image_size_bytes: request.image_size_bytes,
            active_image: self.paths().active_workspace_image(&request.sandbox_id),
            cache_key,
        })
    }

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
        let Some(reuse_key) = common.reuse_key else {
            return active_lease(WorkspaceCacheCheckoutResult::NoReuseKey, None, None);
        };

        let cache_key = common.cache_key(self, reuse_key, working_dir);
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
        let Some(reuse_key) = common.reuse_key else {
            return workspace_drive(
                WorkspaceCacheCheckoutResult::NoReuseKey,
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

        let cache_key = common.cache_key(self, reuse_key, working_dir);
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
                reuse_key,
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

    pub(crate) async fn held_workspace_states_for_profiles(
        &self,
        profile_image_sizes_bytes: &BTreeMap<&str, u64>,
    ) -> Vec<HeldWorkspaceState> {
        self.held_workspace_states_matching_profiles(Some(profile_image_sizes_bytes))
            .await
    }

    /// Inspect cache state without a running profile configuration in tests.
    #[cfg(test)]
    pub(crate) async fn held_workspace_states(&self) -> Vec<HeldWorkspaceState> {
        self.held_workspace_states_matching_profiles(None).await
    }

    async fn held_workspace_states_matching_profiles(
        &self,
        profile_image_sizes_bytes: Option<&BTreeMap<&str, u64>>,
    ) -> Vec<HeldWorkspaceState> {
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
                .metadata_is_publishable_held_workspace_state(
                    cache_key,
                    &metadata,
                    profile_image_sizes_bytes,
                )
                .await
            {
                states.push(HeldWorkspaceState {
                    reuse_key: metadata.reuse_key,
                    last_completed_at: metadata.last_completed_at,
                    workspace_caches: vec![WorkspaceCacheState {
                        profile: metadata.profile_name,
                        workspace_affinity_version: Some(WORKSPACE_AFFINITY_VERSION),
                    }],
                });
            }
            drop(lock);
        }
        let observed_workspace_caches = states
            .iter()
            .map(|state| state.workspace_caches.len())
            .sum::<usize>();
        let states = cap_held_workspace_states(states);
        let retained_workspace_caches = states
            .iter()
            .map(|state| state.workspace_caches.len())
            .sum::<usize>();
        if retained_workspace_caches < observed_workspace_caches {
            info!(
                observed_workspace_caches,
                retained_workspace_states = states.len(),
                retained_workspace_caches,
                "workspace cache state truncated"
            );
        }
        states
    }

    async fn metadata_is_publishable_held_workspace_state(
        &self,
        cache_key: &str,
        metadata: &WorkspaceCacheMetadata,
        profile_image_sizes_bytes: Option<&BTreeMap<&str, u64>>,
    ) -> bool {
        metadata.format_version == CACHE_FORMAT_VERSION
            && metadata.key_version == CACHE_KEY_VERSION
            && metadata.cache_scope == self.inner.cache_scope
            && metadata.drive_layout == WORKSPACE_DRIVE_LAYOUT
            && metadata.state == WorkspaceCacheEntryState::Current
            && metadata.workspace_trust == WorkspaceTrust::Clean
            && is_safe_guest_working_dir(&metadata.working_dir)
            && profile_image_sizes_bytes.is_none_or(|profile_image_sizes_bytes| {
                metadata.working_dir == CANONICAL_WORKING_DIR
                    && profile_image_sizes_bytes
                        .get(metadata.profile_name.as_str())
                        .is_some_and(|image_size| *image_size == metadata.logical_image_size_bytes)
            })
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

    async fn promote_locked(
        &self,
        input: WorkspaceImagePromotionInput<'_>,
    ) -> RunnerResult<WorkspaceImagePromotionOutcome> {
        let promotion_started = Instant::now();
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
                input.reuse_key,
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
                return Ok(WorkspaceImagePromotionOutcome::PreservedExisting);
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
                return Ok(WorkspaceImagePromotionOutcome::SkippedUnpublished);
            }
            Err(e) => {
                warn!(
                    run_id = %input.run_id,
                    cache_key = input.cache_key,
                    error = %e,
                    "workspace image cache promotion skipped: capacity lock unavailable"
                );
                return Ok(WorkspaceImagePromotionOutcome::SkippedUnpublished);
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
            return Ok(WorkspaceImagePromotionOutcome::SkippedUnpublished);
        }
        let image_metadata = fs::symlink_metadata(input.active_image).await?;
        if !image_metadata.is_file() {
            info!(
                run_id = %input.run_id,
                cache_key = input.cache_key,
                active_image = %input.active_image.display(),
                "workspace image cache promotion skipped because active image is not a file"
            );
            return Ok(WorkspaceImagePromotionOutcome::SkippedUnpublished);
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
            return Ok(WorkspaceImagePromotionOutcome::SkippedUnpublished);
        }
        ensure_workspace_cache_entry_dir(&cache_dir).await?;
        let tmp = self.session_workspace_cache_tmp_image(input.cache_key, input.run_id);
        let _ = remove_workspace_cache_path_if_exists(&tmp).await;
        let rename_started = Instant::now();
        let (transfer_mode, transfer_duration) = match fs::rename(input.active_image, &tmp).await {
            Ok(()) => ("rename", rename_started.elapsed()),
            Err(e) if e.kind() == std::io::ErrorKind::CrossesDevices => {
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
                    return Ok(WorkspaceImagePromotionOutcome::SkippedUnpublished);
                }

                let copy_started = Instant::now();
                if let Err(e) = sparse_copy(input.active_image, &tmp).await {
                    let _ = remove_workspace_cache_path_if_exists(&tmp).await;
                    return Err(e);
                }
                ("sparse_copy", copy_started.elapsed())
            }
            Err(e) => {
                let _ = remove_workspace_cache_path_if_exists(&tmp).await;
                return Err(e.into());
            }
        };
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
                "workspace image cache promotion skipped because transferred image size does not match cache key"
            );
            return Ok(WorkspaceImagePromotionOutcome::SkippedUnpublished);
        }
        let tmp_allocated = allocated_bytes(&tmp_metadata);
        if tmp_allocated > budget.max_entry_bytes {
            let _ = remove_workspace_cache_path_if_exists(&tmp).await;
            info!(
                run_id = %input.run_id,
                cache_key = input.cache_key,
                allocated_bytes = tmp_allocated,
                max_entry_bytes = budget.max_entry_bytes,
                "workspace image cache promotion skipped because transferred image is too large"
            );
            return Ok(WorkspaceImagePromotionOutcome::SkippedUnpublished);
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
        if let Err(e) = self
            .publish_session_history_sidecar(
                input.cache_key,
                input.run_id,
                input.session_history_sidecar,
            )
            .await
        {
            warn!(
                run_id = %input.run_id,
                cache_key = input.cache_key,
                error = %e,
                "workspace image cache session history sidecar publish failed"
            );
        }
        let allocated = allocated_bytes(&current_metadata);
        let metadata = WorkspaceCacheMetadata {
            format_version: CACHE_FORMAT_VERSION,
            key_version: CACHE_KEY_VERSION,
            cache_scope: self.inner.cache_scope.clone(),
            profile_name: input.profile_name.to_owned(),
            reuse_key: input.reuse_key.to_owned(),
            cli_agent_session_id: input.cli_agent_session_id.map(str::to_owned),
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
            state: WorkspaceCacheEntryState::Current,
        };
        if let Err(e) = self
            .write_metadata(input.cache_key, input.run_id, metadata)
            .await
        {
            let _ = remove_workspace_cache_path_if_exists(&current).await;
            let _ = self.prune_session_history_sidecar(input.cache_key).await;
            return Err(e);
        }
        info!(
            run_id = %input.run_id,
            cache_key = input.cache_key,
            outcome = "promoted",
            transfer_mode,
            transfer_ms = duration_ms(transfer_duration),
            promotion_ms = duration_ms(promotion_started.elapsed()),
            logical_image_size_bytes,
            source_allocated_bytes = active_allocated,
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
        Ok(WorkspaceImagePromotionOutcome::Promoted)
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

    pub(crate) async fn probe_session_history_sidecar(
        &self,
        expected: &crate::restored_session_identity::RestoredSessionIdentity,
    ) -> Result<WorkspaceSessionHistorySidecar, WorkspaceSessionHistorySidecarMiss> {
        if !self.is_cache_hit() {
            return Err(WorkspaceSessionHistorySidecarMiss::NoCacheHit);
        }
        let cache_key = self
            .cache_key
            .as_deref()
            .ok_or(WorkspaceSessionHistorySidecarMiss::Missing)?;
        self.cache
            .probe_session_history_sidecar(cache_key, expected)
            .await
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
        self,
        run_id: RunId,
        cli_agent_session_id_override: Option<&str>,
        terminal_status: WorkspaceCacheTerminalStatus,
        completed_at: String,
        storage_fingerprints: &StorageFingerprints,
    ) -> RunnerResult<bool> {
        let Some(promotion) = self.into_promotion_context(WorkspaceImagePromotionRequest {
            run_id,
            sandbox_id: sandbox::SandboxId::new_v4(),
            cli_agent_session_id_override,
            restored_session_identity: None,
            terminal_status,
            completed_at,
            storage_fingerprints: storage_fingerprints.clone(),
        }) else {
            debug!(
                run_id = %run_id,
                "workspace image cache promotion skipped: checkout result is not promotable"
            );
            return Ok(false);
        };
        let outcome = promotion.promote().await?;
        Ok(matches!(outcome, WorkspaceImagePromotionOutcome::Promoted))
    }

    fn promotion_target(
        &self,
        cli_agent_session_id_override: Option<&str>,
    ) -> Option<WorkspaceImagePromotionTarget> {
        if !self.workspace_drive_enabled || !is_safe_guest_working_dir(&self.working_dir) {
            return None;
        }

        match self.result {
            WorkspaceCacheCheckoutResult::Hit | WorkspaceCacheCheckoutResult::Miss => {
                Some(WorkspaceImagePromotionTarget {
                    cache_key: self.cache_key.clone()?,
                    reuse_key: self.reuse_key.clone()?,
                    cli_agent_session_id: self
                        .cli_agent_session_id
                        .clone()
                        .or_else(|| cli_agent_session_id_override.map(str::to_owned)),
                })
            }
            WorkspaceCacheCheckoutResult::NoReuseKey => None,
            WorkspaceCacheCheckoutResult::InvalidWorkingDir
            | WorkspaceCacheCheckoutResult::LockBusy
            | WorkspaceCacheCheckoutResult::InvalidMetadata
            | WorkspaceCacheCheckoutResult::DiskPressure => None,
        }
    }

    pub(crate) fn into_promotion_context(
        mut self,
        request: WorkspaceImagePromotionRequest<'_>,
    ) -> Option<WorkspaceImagePromotionContext> {
        let WorkspaceImagePromotionRequest {
            run_id,
            sandbox_id,
            cli_agent_session_id_override,
            restored_session_identity,
            terminal_status,
            completed_at,
            storage_fingerprints,
        } = request;
        let target = self.promotion_target(cli_agent_session_id_override)?;
        let storage_fingerprints = match terminal_status {
            WorkspaceCacheTerminalStatus::Success => storage_fingerprints,
            WorkspaceCacheTerminalStatus::NonzeroExit | WorkspaceCacheTerminalStatus::Cancelled => {
                storage_fingerprints.tainted_paths_including(self.previous_storage.as_ref())
            }
        };

        Some(WorkspaceImagePromotionContext {
            cache: self.cache.clone(),
            cache_key: target.cache_key,
            entry_lock: self.entry_lock.take(),
            run_id,
            sandbox_id,
            profile_name: self.profile_name.clone(),
            reuse_key: target.reuse_key,
            cli_agent_session_id: target.cli_agent_session_id,
            working_dir: self.working_dir.clone(),
            active_image: self.active_image.clone(),
            image_size_bytes: self.image_size_bytes,
            consumed_cache_hit: self.consumed_cache_hit,
            terminal_status,
            completed_at,
            storage_fingerprints,
            restored_session_identity: restored_session_identity.cloned(),
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

    pub(crate) fn reuse_key(&self) -> &str {
        &self.reuse_key
    }

    pub(crate) fn restored_session_identity(
        &self,
    ) -> Option<&crate::restored_session_identity::RestoredSessionIdentity> {
        self.restored_session_identity.as_ref()
    }

    pub(crate) fn validate_identity(
        &self,
        expected: &WorkspaceImagePromotionIdentity,
    ) -> Result<(), WorkspaceImagePromotionIdentityMismatch> {
        if self.sandbox_id != expected.sandbox_id {
            return Err(WorkspaceImagePromotionIdentityMismatch::SandboxId);
        }
        if self.profile_name != expected.profile_name {
            return Err(WorkspaceImagePromotionIdentityMismatch::ProfileName);
        }
        if self.reuse_key != expected.reuse_key {
            return Err(WorkspaceImagePromotionIdentityMismatch::ReuseKey);
        }
        if self.working_dir != expected.working_dir {
            return Err(WorkspaceImagePromotionIdentityMismatch::WorkingDir);
        }
        if self.image_size_bytes != expected.image_size_bytes {
            return Err(WorkspaceImagePromotionIdentityMismatch::ImageSizeBytes);
        }
        if self.active_image != expected.active_image {
            return Err(WorkspaceImagePromotionIdentityMismatch::ActiveImage);
        }
        if self.cache_key != expected.cache_key {
            return Err(WorkspaceImagePromotionIdentityMismatch::CacheKey);
        }
        Ok(())
    }

    pub(crate) fn validate_expected_identity(
        &self,
        cache: &SessionWorkspaceCache,
        request: WorkspaceImagePromotionIdentityRequest<'_>,
    ) -> Result<(), WorkspaceImagePromotionIdentityMismatch> {
        let expected = cache.expected_promotion_identity(request)?;
        self.validate_identity(&expected)
    }

    pub(crate) fn validate_stored_cache_identity(
        &self,
        request: WorkspaceImagePromotionIdentityRequest<'_>,
    ) -> Result<(), WorkspaceImagePromotionIdentityMismatch> {
        self.validate_expected_identity(&self.cache, request)
    }

    #[cfg(test)]
    pub(crate) async fn promote(&self) -> RunnerResult<WorkspaceImagePromotionOutcome> {
        self.promote_without_session_history_sidecar().await
    }

    pub(crate) async fn try_acquire_session_history_sidecar_entry_guard(
        &self,
    ) -> Option<WorkspaceSessionHistorySidecarEntryGuard> {
        let restored_session_identity = self.restored_session_identity.clone()?;
        let late_entry_lock = match self.entry_lock.as_ref() {
            Some(_) => None,
            None => {
                match crate::lock::try_acquire(self.cache.entry_lock_path(&self.cache_key)).await {
                    Ok(lock) => Some(lock),
                    Err(e) => {
                        info!(
                            run_id = %self.run_id,
                            cache_key = self.cache_key,
                            error = %e,
                            "workspace image cache sidecar staging skipped: late entry lock unavailable"
                        );
                        return None;
                    }
                }
            }
        };
        Some(WorkspaceSessionHistorySidecarEntryGuard {
            cache: self.cache.clone(),
            cache_key: self.cache_key.clone(),
            run_id: self.run_id,
            restored_session_identity,
            _late_entry_lock: late_entry_lock,
        })
    }

    pub(crate) async fn promote_without_session_history_sidecar(
        &self,
    ) -> RunnerResult<WorkspaceImagePromotionOutcome> {
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
                        return Ok(WorkspaceImagePromotionOutcome::SkippedUnpublished);
                    }
                }
            }
        };

        let publication = if self.consumed_cache_hit {
            WorkspaceSessionHistorySidecarPublication::PreserveExisting
        } else {
            WorkspaceSessionHistorySidecarPublication::Prune
        };
        self.promote_locked(publication).await
    }

    async fn promote_locked(
        &self,
        session_history_sidecar: WorkspaceSessionHistorySidecarPublication<'_>,
    ) -> RunnerResult<WorkspaceImagePromotionOutcome> {
        self.cache
            .promote_locked(WorkspaceImagePromotionInput {
                run_id: self.run_id,
                cache_key: &self.cache_key,
                profile_name: &self.profile_name,
                reuse_key: &self.reuse_key,
                cli_agent_session_id: self.cli_agent_session_id.as_deref(),
                working_dir: &self.working_dir,
                active_image: &self.active_image,
                image_size_bytes: self.image_size_bytes,
                terminal_status: self.terminal_status,
                completed_at: &self.completed_at,
                storage_fingerprints: &self.storage_fingerprints,
                session_history_sidecar,
            })
            .await
    }

    pub(crate) async fn abandon_unpublished(self, reason: &str) -> RunnerResult<bool> {
        let Self {
            cache,
            cache_key,
            entry_lock,
            run_id,
            sandbox_id,
            profile_name,
            reuse_key,
            cli_agent_session_id: _,
            consumed_cache_hit,
            ..
        } = self;
        let Some(_entry_lock) = entry_lock else {
            info!(
                run_id = %run_id,
                sandbox_id = %sandbox_id,
                profile_name,
                reuse_key_fingerprint = %crate::paths::short_digest(&reuse_key),
                reuse_key_kind = crate::types::reuse_key_kind(&reuse_key),
                cache_key,
                reason,
                "workspace image cache promotion context abandoned without entry lock"
            );
            return Ok(false);
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

    #[cfg(test)]
    pub(crate) fn try_into_active_lease(
        self,
        expected: &WorkspaceImagePromotionIdentity,
        workspace_drive_available: bool,
    ) -> Result<WorkspaceImageLease, WorkspaceImagePromotionIdentityMismatch> {
        self.validate_identity(expected)?;
        Ok(self.into_active_lease_unchecked(workspace_drive_available))
    }

    pub(crate) fn try_into_active_lease_preserving_context(
        self,
        expected: &WorkspaceImagePromotionIdentity,
        workspace_drive_available: bool,
    ) -> Result<WorkspaceImageLease, Box<WorkspaceImagePromotionIdentityFailure>> {
        if let Err(mismatch) = self.validate_identity(expected) {
            return Err(Box::new(WorkspaceImagePromotionIdentityFailure {
                promotion: self,
                mismatch,
            }));
        }
        Ok(self.into_active_lease_unchecked(workspace_drive_available))
    }

    fn into_active_lease_unchecked(self, workspace_drive_available: bool) -> WorkspaceImageLease {
        let Self {
            cache,
            cache_key,
            entry_lock,
            run_id: _,
            sandbox_id: _,
            profile_name,
            reuse_key,
            cli_agent_session_id,
            working_dir,
            active_image,
            image_size_bytes,
            consumed_cache_hit,
            terminal_status: _,
            completed_at: _,
            storage_fingerprints,
            restored_session_identity: _,
        } = self;
        let base = WorkspaceImageLeaseBase {
            cache,
            profile_name,
            reuse_key: Some(reuse_key),
            cli_agent_session_id,
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
                previous_storage: Some(storage_fingerprints),
                entry_lock,
                workspace_drive_enabled: workspace_drive_available,
                result: WorkspaceCacheCheckoutResult::Miss,
            },
        )
    }
}

impl WorkspaceSessionHistorySidecarEntryGuard {
    pub(crate) fn session_history_sidecar_tmp_path(&self) -> PathBuf {
        self.cache
            .session_workspace_cache_tmp_sidecar(&self.cache_key, self.run_id)
    }

    pub(crate) fn session_history_sidecar_source(
        &self,
        tmp_path: PathBuf,
        representation: super::types::WorkspaceSessionHistorySidecarRepresentation,
        encoded_size: u64,
    ) -> WorkspaceSessionHistorySidecarPromotionSource {
        WorkspaceSessionHistorySidecarPromotionSource {
            tmp_path,
            representation,
            encoded_size,
            restored_session_identity: self.restored_session_identity.clone(),
        }
    }

    pub(crate) async fn discard_session_history_sidecar_source(
        &self,
        source: &WorkspaceSessionHistorySidecarPromotionSource,
    ) {
        self.cache
            .discard_session_history_sidecar_source(source)
            .await;
    }

    pub(crate) async fn promote_with_session_history_sidecar(
        &self,
        promotion: &WorkspaceImagePromotionContext,
        source: &WorkspaceSessionHistorySidecarPromotionSource,
    ) -> RunnerResult<WorkspaceImagePromotionOutcome> {
        if self.cache_key != promotion.cache_key || self.run_id != promotion.run_id {
            return Err(RunnerError::Internal(
                "workspace session history sidecar guard does not match promotion context".into(),
            ));
        }
        promotion
            .promote_locked(WorkspaceSessionHistorySidecarPublication::Replace(source))
            .await
    }
}

pub(crate) fn cap_held_workspace_states(
    states: Vec<HeldWorkspaceState>,
) -> Vec<HeldWorkspaceState> {
    struct ObservedWorkspaceState {
        last_completed_at: String,
        workspace_caches: BTreeMap<String, (String, WorkspaceCacheState)>,
    }

    let mut by_reuse_key = BTreeMap::<String, ObservedWorkspaceState>::new();
    for state in states {
        let reuse_key = state.reuse_key.clone();
        let observed = by_reuse_key
            .entry(reuse_key)
            .or_insert_with(|| ObservedWorkspaceState {
                last_completed_at: state.last_completed_at.clone(),
                workspace_caches: BTreeMap::new(),
            });
        if state.last_completed_at > observed.last_completed_at {
            observed.last_completed_at = state.last_completed_at.clone();
        }
        for workspace_cache in state.workspace_caches {
            match observed
                .workspace_caches
                .entry(workspace_cache.profile.clone())
            {
                std::collections::btree_map::Entry::Vacant(entry) => {
                    entry.insert((state.last_completed_at.clone(), workspace_cache));
                }
                std::collections::btree_map::Entry::Occupied(mut entry) => {
                    let (existing_completed_at, existing) = entry.get_mut();
                    let capability_order = workspace_cache
                        .workspace_affinity_version
                        .cmp(&existing.workspace_affinity_version);
                    if capability_order.is_gt()
                        || (capability_order.is_eq()
                            && state.last_completed_at > *existing_completed_at)
                    {
                        *existing_completed_at = state.last_completed_at.clone();
                        *existing = workspace_cache;
                    }
                }
            }
        }
    }

    let mut states: Vec<HeldWorkspaceState> = by_reuse_key
        .into_iter()
        .map(|(reuse_key, state)| HeldWorkspaceState {
            reuse_key,
            last_completed_at: state.last_completed_at,
            workspace_caches: state
                .workspace_caches
                .into_values()
                .map(|(_, workspace_cache)| workspace_cache)
                .take(MAX_WORKSPACE_CACHES_PER_REUSE_KEY)
                .collect(),
        })
        .collect();
    states.sort_unstable_by(|a, b| {
        b.last_completed_at
            .cmp(&a.last_completed_at)
            .then_with(|| a.reuse_key.cmp(&b.reuse_key))
    });

    let mut retained = Vec::new();
    let mut retained_workspace_caches = 0;
    for mut state in states {
        if retained.len() == MAX_HELD_WORKSPACE_STATES
            || retained_workspace_caches == MAX_WORKSPACE_CACHES_PER_HEARTBEAT
        {
            break;
        }
        let remaining = MAX_WORKSPACE_CACHES_PER_HEARTBEAT - retained_workspace_caches;
        state.workspace_caches.truncate(remaining);
        if state.workspace_caches.is_empty() {
            continue;
        }
        retained_workspace_caches += state.workspace_caches.len();
        retained.push(state);
    }
    retained.sort_unstable_by(|a, b| a.reuse_key.cmp(&b.reuse_key));
    retained
}
