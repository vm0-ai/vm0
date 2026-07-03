use std::os::unix::fs::MetadataExt;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tokio::fs;
use tracing::info;

use crate::error::{RunnerError, RunnerResult};
use crate::ids::RunId;
use crate::storage_fingerprints::StorageFingerprints;

use super::fs::{
    allocated_bytes, ensure_workspace_cache_entry_dir, remove_workspace_cache_path_if_exists,
};
use super::types::WorkspaceCacheTerminalStatus;
use super::{
    CACHE_FORMAT_VERSION, CACHE_KEY_VERSION, SessionWorkspaceCache, WORKSPACE_DRIVE_LAYOUT,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum WorkspaceCacheState {
    Current,
    Dirty,
    Invalid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum WorkspaceTrust {
    Clean,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkspaceCacheMetadata {
    pub(super) format_version: u32,
    pub(super) key_version: u32,
    pub(super) cache_scope: String,
    pub(super) profile_name: String,
    pub(super) session_id: String,
    pub(super) working_dir: String,
    pub(super) last_completed_at: String,
    pub(super) last_used_at: String,
    pub(super) last_terminal_status: WorkspaceCacheTerminalStatus,
    pub(super) workspace_trust: WorkspaceTrust,
    pub(super) logical_image_size_bytes: u64,
    pub(super) allocated_bytes: u64,
    pub(super) current_image: WorkspaceImageFileIdentity,
    pub(super) drive_layout: String,
    pub(super) storage_fingerprints: StorageFingerprints,
    pub(super) state: WorkspaceCacheState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkspaceImageFileIdentity {
    pub(super) dev: u64,
    pub(super) ino: u64,
    pub(super) len: u64,
}

impl WorkspaceImageFileIdentity {
    pub(super) fn from_metadata(metadata: &std::fs::Metadata) -> Self {
        Self {
            dev: metadata.dev(),
            ino: metadata.ino(),
            len: metadata.len(),
        }
    }
}

impl SessionWorkspaceCache {
    pub(super) async fn read_valid_metadata(
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

    pub(super) async fn metadata_matches_current_image(
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

    pub(super) async fn read_metadata_file(
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

    pub(super) async fn write_metadata(
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

    pub(super) async fn invalidate_current_image(
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

pub(super) fn validate_current_image_identity(
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
