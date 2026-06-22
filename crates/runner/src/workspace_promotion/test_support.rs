use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use sandbox::SandboxId;

use crate::ids::RunId;
use crate::paths::RunnerPaths;
use crate::storage_fingerprints::StorageFingerprints;
use crate::workspace_image_cache::{
    SessionWorkspaceCache, WorkspaceCacheCheckoutResult, WorkspaceCacheTerminalStatus,
    WorkspaceImageLeaseIdentity, WorkspaceImagePrepareRequest, WorkspaceImagePromotionContext,
    WorkspaceImagePromotionOutcome, WorkspaceImagePromotionRequest,
};

pub(crate) const TEST_COMPLETED_AT: &str = "2026-06-03T00:00:00.000Z";
const TEST_WORKSPACE_IMAGE: &[u8] = b"workspace image";

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
        let workspace_image = cache
            .prepare(WorkspaceImagePrepareRequest {
                identity: WorkspaceImageLeaseIdentity {
                    run_id,
                    sandbox_id,
                    profile_name: "vm0/default",
                    cli_agent_session_id: Some(session_id),
                    working_dir: CANONICAL_WORKING_DIR,
                    image_size_bytes: TEST_WORKSPACE_IMAGE.len() as u64,
                },
                workspace_drive_required: true,
            })
            .await;
        tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
            .await
            .unwrap();
        tokio::fs::write(
            paths.active_workspace_image(&sandbox_id),
            TEST_WORKSPACE_IMAGE,
        )
        .await
        .unwrap();
        let promotion = workspace_image
            .into_promotion_context(WorkspaceImagePromotionRequest {
                run_id,
                sandbox_id,
                cli_agent_session_id_override: Some(session_id),
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

    pub(crate) async fn new_from_cache_hit(session_id: &str) -> Self {
        let seed = Self::new(session_id).await;
        assert_eq!(
            seed.promotion.promote().await.unwrap(),
            WorkspaceImagePromotionOutcome::Promoted
        );
        let Self {
            _dir,
            cache,
            promotion,
            sandbox_id: _,
            session_id,
        } = seed;
        drop(promotion);

        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let workspace_image = cache
            .prepare(WorkspaceImagePrepareRequest {
                identity: WorkspaceImageLeaseIdentity {
                    run_id,
                    sandbox_id,
                    profile_name: "vm0/default",
                    cli_agent_session_id: Some(&session_id),
                    working_dir: CANONICAL_WORKING_DIR,
                    image_size_bytes: TEST_WORKSPACE_IMAGE.len() as u64,
                },
                workspace_drive_required: true,
            })
            .await;
        assert_eq!(workspace_image.result(), WorkspaceCacheCheckoutResult::Hit);
        let promotion = workspace_image
            .into_promotion_context(WorkspaceImagePromotionRequest {
                run_id,
                sandbox_id,
                cli_agent_session_id_override: Some(&session_id),
                terminal_status: WorkspaceCacheTerminalStatus::Success,
                completed_at: "2026-06-04T00:00:00.000Z".into(),
                storage_fingerprints: StorageFingerprints::default(),
                promotable: true,
            })
            .expect("workspace image cache hit should be promotable");

        Self {
            _dir,
            cache,
            promotion,
            sandbox_id,
            session_id,
        }
    }

    pub(crate) async fn checkout_result(
        cache: &SessionWorkspaceCache,
        session_id: &str,
    ) -> WorkspaceCacheCheckoutResult {
        cache
            .prepare(WorkspaceImagePrepareRequest {
                identity: WorkspaceImageLeaseIdentity {
                    run_id: RunId::new_v4(),
                    sandbox_id: SandboxId::new_v4(),
                    profile_name: "vm0/default",
                    cli_agent_session_id: Some(session_id),
                    working_dir: CANONICAL_WORKING_DIR,
                    image_size_bytes: TEST_WORKSPACE_IMAGE.len() as u64,
                },
                workspace_drive_required: true,
            })
            .await
            .result()
    }
}
