use std::path::{Path, PathBuf};

use crate::ids::RunId;
use crate::paths::{
    scoped_workspace_image_cache_key, workspace_image_cache_capacity_lock_path,
    workspace_image_cache_lock_path,
};

use super::WorkspaceImageCache;
use super::metadata::WorkspaceCacheMetadata;

#[derive(Clone, Debug)]
pub(super) struct CacheEntryPaths {
    entry_dir: PathBuf,
    metadata: PathBuf,
    current_image: PathBuf,
    session_history_sidecar_metadata: PathBuf,
}

impl CacheEntryPaths {
    pub(super) fn new(cache_dir: &Path, cache_key: &str) -> Self {
        let entry_dir = cache_dir.join(cache_key);
        Self {
            metadata: entry_dir.join("metadata.json"),
            current_image: entry_dir.join("current.ext4"),
            session_history_sidecar_metadata: entry_dir.join("session-history.metadata.json"),
            entry_dir,
        }
    }

    pub(super) fn lock_path(lock_dir: &Path, cache_key: &str) -> PathBuf {
        workspace_image_cache_lock_path(lock_dir, cache_key)
    }

    pub(super) fn entry_dir(&self) -> &Path {
        &self.entry_dir
    }

    pub(super) fn metadata(&self) -> &Path {
        &self.metadata
    }

    pub(super) fn current_image(&self) -> &Path {
        &self.current_image
    }

    pub(super) fn session_history_sidecar_metadata(&self) -> &Path {
        &self.session_history_sidecar_metadata
    }

    pub(super) fn tmp_image(&self, run_id: RunId) -> PathBuf {
        self.entry_dir.join(format!("current.ext4.tmp.{run_id}"))
    }

    pub(super) fn tmp_session_history_sidecar(&self, run_id: RunId) -> PathBuf {
        self.entry_dir
            .join(format!("session-history.blob.tmp.{run_id}"))
    }

    pub(super) fn tmp_session_history_sidecar_metadata(&self, run_id: RunId) -> PathBuf {
        self.entry_dir
            .join(format!("session-history.metadata.json.tmp.{run_id}"))
    }
}

impl WorkspaceImageCache {
    pub(super) fn workspace_image_cache_dir(&self) -> &Path {
        &self.inner.cache_dir
    }

    pub(super) fn workspace_image_cache_fs_stats_path(&self) -> PathBuf {
        super::fs::existing_fs_stats_path(self.workspace_image_cache_dir())
    }

    pub(super) fn workspace_image_cache_entry_dir(&self, cache_key: &str) -> PathBuf {
        self.entry_paths(cache_key).entry_dir().to_path_buf()
    }

    pub(super) fn workspace_image_cache_metadata(&self, cache_key: &str) -> PathBuf {
        self.entry_paths(cache_key).metadata().to_path_buf()
    }

    pub(super) fn workspace_image_cache_current_image(&self, cache_key: &str) -> PathBuf {
        self.entry_paths(cache_key).current_image().to_path_buf()
    }

    pub(super) fn workspace_image_cache_tmp_image(
        &self,
        cache_key: &str,
        run_id: RunId,
    ) -> PathBuf {
        self.entry_paths(cache_key).tmp_image(run_id)
    }

    pub(super) fn workspace_image_cache_tmp_sidecar(
        &self,
        cache_key: &str,
        run_id: RunId,
    ) -> PathBuf {
        self.entry_paths(cache_key)
            .tmp_session_history_sidecar(run_id)
    }

    pub(super) fn workspace_image_cache_tmp_sidecar_metadata(
        &self,
        cache_key: &str,
        run_id: RunId,
    ) -> PathBuf {
        self.entry_paths(cache_key)
            .tmp_session_history_sidecar_metadata(run_id)
    }

    pub(super) fn scoped_cache_key(
        &self,
        profile_name: &str,
        reuse_key: &str,
        working_dir: &str,
        image_size_bytes: u64,
    ) -> String {
        scoped_workspace_image_cache_key(
            &self.inner.cache_scope,
            profile_name,
            reuse_key,
            working_dir,
            image_size_bytes,
        )
    }

    pub(super) fn metadata_matches_cache_key(
        &self,
        cache_key: &str,
        metadata: &WorkspaceCacheMetadata,
    ) -> bool {
        scoped_workspace_image_cache_key(
            &metadata.cache_scope,
            &metadata.profile_name,
            &metadata.reuse_key,
            &metadata.working_dir,
            metadata.logical_image_size_bytes,
        ) == cache_key
    }

    pub(super) fn entry_paths(&self, cache_key: &str) -> CacheEntryPaths {
        CacheEntryPaths::new(self.workspace_image_cache_dir(), cache_key)
    }

    pub(super) fn entry_lock_path(&self, cache_key: &str) -> PathBuf {
        CacheEntryPaths::lock_path(&self.inner.lock_dir, cache_key)
    }

    pub(super) fn capacity_lock_path(&self) -> PathBuf {
        workspace_image_cache_capacity_lock_path(&self.inner.lock_dir)
    }
}

pub(super) fn is_cache_key_name(name: &str) -> bool {
    name.len() == 64
        && name
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
