use std::path::Path;

use api_contracts::generated::constants::runners::RESUME_SESSION_HISTORY_MAX_BYTES;
use guest_contracts::session_history_identity::{
    FinalSessionHistoryFramework, FinalSessionHistoryRefKind,
};
use serde::{Deserialize, Serialize};
use tokio::fs;

use crate::error::{RunnerError, RunnerResult};
use crate::ids::RunId;
use crate::restored_session_identity::{RestoredSessionIdentity, RestoredSessionIdentityFields};

use super::fs::{
    ensure_workspace_cache_entry_dir, remove_workspace_cache_path_if_exists,
    workspace_cache_existing_path_allocated_bytes,
};
use super::metadata::WorkspaceImageFileIdentity;
use super::types::{
    WorkspaceSessionHistorySidecar, WorkspaceSessionHistorySidecarMiss,
    WorkspaceSessionHistorySidecarPromotionSource, WorkspaceSessionHistorySidecarPublication,
    WorkspaceSessionHistorySidecarRepresentation,
};
use super::{SessionWorkspaceCache, entry::CacheEntryPaths};

const SESSION_HISTORY_SIDECAR_FORMAT_VERSION: u8 = 1;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSessionHistorySidecarMetadata {
    version: u8,
    framework: FinalSessionHistoryFramework,
    session_id_hash: String,
    history_ref_kind: FinalSessionHistoryRefKind,
    history_hash: String,
    history_size_bytes: u64,
    representation: WorkspaceSessionHistorySidecarRepresentation,
    encoded_size: u64,
    body_file: WorkspaceImageFileIdentity,
}

impl WorkspaceSessionHistorySidecarMetadata {
    fn from_source(
        source: &WorkspaceSessionHistorySidecarPromotionSource,
        body_metadata: &std::fs::Metadata,
    ) -> Option<Self> {
        let RestoredSessionIdentityFields {
            framework,
            session_id_hash,
            history_ref_kind,
            history_hash,
            history_size_bytes,
        } = source.restored_session_identity.cache_fields()?;
        Some(Self {
            version: SESSION_HISTORY_SIDECAR_FORMAT_VERSION,
            framework,
            session_id_hash: session_id_hash.to_owned(),
            history_ref_kind,
            history_hash: history_hash.to_owned(),
            history_size_bytes,
            representation: source.representation,
            encoded_size: source.encoded_size,
            body_file: WorkspaceImageFileIdentity::from_metadata(body_metadata),
        })
    }

    fn validate_for_request(
        &self,
        expected: &RestoredSessionIdentity,
    ) -> Result<(), WorkspaceSessionHistorySidecarMiss> {
        if self.version != SESSION_HISTORY_SIDECAR_FORMAT_VERSION {
            return Err(WorkspaceSessionHistorySidecarMiss::InvalidMetadata);
        }
        if self.encoded_size == 0 || self.encoded_size > RESUME_SESSION_HISTORY_MAX_BYTES {
            return Err(WorkspaceSessionHistorySidecarMiss::InvalidMetadata);
        }
        let fields = expected
            .cache_fields()
            .ok_or(WorkspaceSessionHistorySidecarMiss::IdentityMismatch)?;
        if self.framework != fields.framework
            || self.session_id_hash != fields.session_id_hash
            || self.history_ref_kind != fields.history_ref_kind
            || self.history_hash != fields.history_hash
            || self.history_size_bytes != fields.history_size_bytes
        {
            return Err(WorkspaceSessionHistorySidecarMiss::IdentityMismatch);
        }
        match (self.framework, self.representation) {
            (_, WorkspaceSessionHistorySidecarRepresentation::Raw)
                if self.encoded_size == self.history_size_bytes =>
            {
                Ok(())
            }
            (
                FinalSessionHistoryFramework::Codex,
                WorkspaceSessionHistorySidecarRepresentation::CodexZstd,
            ) => Ok(()),
            _ => Err(WorkspaceSessionHistorySidecarMiss::UnsupportedFormat),
        }
    }

    fn validate_body_metadata(
        &self,
        body_metadata: &std::fs::Metadata,
    ) -> Result<(), WorkspaceSessionHistorySidecarMiss> {
        if !body_metadata.is_file()
            || WorkspaceImageFileIdentity::from_metadata(body_metadata) != self.body_file
            || body_metadata.len() != self.encoded_size
        {
            return Err(WorkspaceSessionHistorySidecarMiss::FileIdentityMismatch);
        }
        Ok(())
    }
}

impl SessionWorkspaceCache {
    pub(super) async fn probe_session_history_sidecar(
        &self,
        cache_key: &str,
        expected: &RestoredSessionIdentity,
    ) -> Result<WorkspaceSessionHistorySidecar, WorkspaceSessionHistorySidecarMiss> {
        let paths = self.entry_paths(cache_key);
        let metadata = self
            .read_session_history_sidecar_metadata(paths.session_history_sidecar_metadata())
            .await?;
        metadata.validate_for_request(expected)?;
        let body_metadata = fs::symlink_metadata(paths.session_history_sidecar())
            .await
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    WorkspaceSessionHistorySidecarMiss::BodyMissing
                } else {
                    WorkspaceSessionHistorySidecarMiss::FileIdentityMismatch
                }
            })?;
        metadata.validate_body_metadata(&body_metadata)?;
        Ok(WorkspaceSessionHistorySidecar {
            path: paths.session_history_sidecar().to_path_buf(),
            representation: metadata.representation,
            encoded_size: metadata.encoded_size,
        })
    }

    pub(super) async fn publish_session_history_sidecar(
        &self,
        cache_key: &str,
        run_id: RunId,
        publication: WorkspaceSessionHistorySidecarPublication<'_>,
    ) -> RunnerResult<()> {
        let paths = self.entry_paths(cache_key);
        match publication {
            WorkspaceSessionHistorySidecarPublication::PreserveExisting => {}
            WorkspaceSessionHistorySidecarPublication::Replace(source) => {
                self.publish_session_history_sidecar_source(cache_key, run_id, &paths, source)
                    .await?;
            }
            WorkspaceSessionHistorySidecarPublication::Prune => {
                self.prune_session_history_sidecar(cache_key).await?;
            }
        }
        Ok(())
    }

    pub(super) async fn discard_session_history_sidecar_source(
        &self,
        source: &WorkspaceSessionHistorySidecarPromotionSource,
    ) {
        let _ = remove_workspace_cache_path_if_exists(&source.tmp_path).await;
    }

    pub(super) async fn session_history_sidecar_allocated_bytes(&self, cache_key: &str) -> u64 {
        let paths = self.entry_paths(cache_key);
        let body = workspace_cache_existing_path_allocated_bytes(paths.session_history_sidecar())
            .await
            .ok()
            .flatten()
            .unwrap_or(0);
        let metadata =
            workspace_cache_existing_path_allocated_bytes(paths.session_history_sidecar_metadata())
                .await
                .ok()
                .flatten()
                .unwrap_or(0);
        body.saturating_add(metadata)
    }

    async fn publish_session_history_sidecar_source(
        &self,
        cache_key: &str,
        run_id: RunId,
        paths: &CacheEntryPaths,
        source: &WorkspaceSessionHistorySidecarPromotionSource,
    ) -> RunnerResult<()> {
        let tmp_metadata = fs::symlink_metadata(&source.tmp_path).await?;
        if !tmp_metadata.is_file()
            || tmp_metadata.len() != source.encoded_size
            || source.encoded_size == 0
            || source.encoded_size > RESUME_SESSION_HISTORY_MAX_BYTES
        {
            let _ = remove_workspace_cache_path_if_exists(&source.tmp_path).await;
            return Ok(());
        }
        let Some(sidecar_metadata) =
            WorkspaceSessionHistorySidecarMetadata::from_source(source, &tmp_metadata)
        else {
            let _ = remove_workspace_cache_path_if_exists(&source.tmp_path).await;
            return Ok(());
        };
        ensure_workspace_cache_entry_dir(paths.entry_dir()).await?;
        let tmp_metadata_path =
            self.session_workspace_cache_tmp_sidecar_metadata(cache_key, run_id);
        let sidecar_metadata_path = paths.session_history_sidecar_metadata();
        let sidecar_body_path = paths.session_history_sidecar();
        let _ = remove_workspace_cache_path_if_exists(&tmp_metadata_path).await;
        let bytes = serde_json::to_vec_pretty(&sidecar_metadata).map_err(|e| {
            RunnerError::Internal(format!("serialize workspace session history sidecar: {e}"))
        })?;
        if let Err(e) = fs::write(&tmp_metadata_path, bytes).await {
            let _ = remove_workspace_cache_path_if_exists(&tmp_metadata_path).await;
            let _ = remove_workspace_cache_path_if_exists(&source.tmp_path).await;
            return Err(e.into());
        }
        let _ = remove_workspace_cache_path_if_exists(sidecar_metadata_path).await;
        let _ = remove_workspace_cache_path_if_exists(sidecar_body_path).await;
        if let Err(e) = fs::rename(&source.tmp_path, sidecar_body_path).await {
            let _ = remove_workspace_cache_path_if_exists(&tmp_metadata_path).await;
            let _ = remove_workspace_cache_path_if_exists(&source.tmp_path).await;
            return Err(e.into());
        }
        if let Err(e) = fs::rename(&tmp_metadata_path, sidecar_metadata_path).await {
            let _ = remove_workspace_cache_path_if_exists(&tmp_metadata_path).await;
            let _ = remove_workspace_cache_path_if_exists(sidecar_body_path).await;
            return Err(e.into());
        }
        Ok(())
    }

    pub(super) async fn prune_session_history_sidecar(&self, cache_key: &str) -> RunnerResult<()> {
        let paths = self.entry_paths(cache_key);
        let metadata_result =
            remove_workspace_cache_path_if_exists(paths.session_history_sidecar_metadata()).await;
        let body_result =
            remove_workspace_cache_path_if_exists(paths.session_history_sidecar()).await;
        metadata_result?;
        body_result?;
        Ok(())
    }

    async fn read_session_history_sidecar_metadata(
        &self,
        path: &Path,
    ) -> Result<WorkspaceSessionHistorySidecarMetadata, WorkspaceSessionHistorySidecarMiss> {
        let bytes = crate::state_file::read_to_bytes_required(
            path,
            crate::state_file::WORKSPACE_METADATA_MAX_BYTES,
            crate::state_file::OwnerCheck::None,
        )
        .await
        .map_err(|error| match error {
            RunnerError::Io(e) if e.kind() == std::io::ErrorKind::NotFound => {
                WorkspaceSessionHistorySidecarMiss::Missing
            }
            _ => WorkspaceSessionHistorySidecarMiss::InvalidMetadata,
        })?;
        serde_json::from_slice(&bytes)
            .map_err(|_| WorkspaceSessionHistorySidecarMiss::InvalidMetadata)
    }
}
