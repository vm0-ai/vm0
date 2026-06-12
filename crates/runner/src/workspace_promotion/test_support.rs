use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use sandbox::SandboxId;

use crate::ids::RunId;
use crate::paths::RunnerPaths;
use crate::storage_fingerprints::StorageFingerprints;
use crate::workspace_image_cache::{
    SessionWorkspaceCache, WorkspaceCacheTerminalStatus, WorkspaceImagePrepareRequest,
    WorkspaceImagePromotionContext, WorkspaceImagePromotionRequest,
};

pub(crate) const TEST_COMPLETED_AT: &str = "2026-06-03T00:00:00.000Z";

pub(crate) struct WorkspacePromotionFixture {
    pub(crate) _dir: tempfile::TempDir,
    pub(crate) cache: SessionWorkspaceCache,
    pub(crate) promotion: WorkspaceImagePromotionContext,
    pub(crate) sandbox_id: SandboxId,
    pub(crate) session_id: String,
}

impl WorkspacePromotionFixture {
    pub(crate) async fn new(session_id: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let image = b"workspace image";
        let workspace_image = cache
            .prepare(WorkspaceImagePrepareRequest {
                run_id,
                sandbox_id,
                profile_name: "vm0/default",
                session_id: Some(session_id),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: image.len() as u64,
                workspace_drive_required: true,
            })
            .await;
        tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
            .await
            .unwrap();
        tokio::fs::write(paths.active_workspace_image(&sandbox_id), image)
            .await
            .unwrap();
        let promotion = workspace_image
            .into_promotion_context(WorkspaceImagePromotionRequest {
                run_id,
                sandbox_id,
                session_id_override: Some(session_id),
                terminal_status: WorkspaceCacheTerminalStatus::Success,
                completed_at: TEST_COMPLETED_AT.into(),
                storage_fingerprints: StorageFingerprints::default(),
                promotable: true,
            })
            .expect("workspace image should be promotable");

        Self {
            _dir: dir,
            cache,
            promotion,
            sandbox_id,
            session_id: session_id.into(),
        }
    }
}
