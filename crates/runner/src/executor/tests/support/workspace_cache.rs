use std::path::PathBuf;

use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use sandbox::SandboxId;

use crate::ids::RunId;
use crate::paths::RunnerPaths;
use crate::workspace_image_cache::{
    SessionWorkspaceCache, WorkspaceCacheCheckoutResult, WorkspaceCacheTerminalStatus,
    WorkspaceImagePrepareRequest,
};

pub(in crate::executor::tests) async fn seed_workspace_image_cache(
    cache: &SessionWorkspaceCache,
    runner_paths: &RunnerPaths,
    session_id: &str,
    workspace_disk_mb: u32,
) -> PathBuf {
    let sandbox_id = SandboxId::new_v4();
    let run_id = RunId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id,
            sandbox_id,
            profile_name: "vm0/default",
            session_id: Some(session_id),
            working_dir: CANONICAL_WORKING_DIR,
            image_size_bytes: u64::from(workspace_disk_mb) * 1024 * 1024,
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Miss);

    let active_image = runner_paths.active_workspace_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    let file = tokio::fs::File::create(&active_image).await.unwrap();
    file.set_len(u64::from(workspace_disk_mb) * 1024 * 1024)
        .await
        .unwrap();
    drop(file);

    assert!(
        lease
            .promote(
                run_id,
                None,
                WorkspaceCacheTerminalStatus::Success,
                "2026-06-01T00:00:00.000Z".into(),
                &crate::idle_pool::StorageFingerprints::default(),
            )
            .await
            .unwrap()
    );
    drop(lease);

    let hit = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id: RunId::new_v4(),
            sandbox_id: SandboxId::new_v4(),
            profile_name: "vm0/default",
            session_id: Some(session_id),
            working_dir: CANONICAL_WORKING_DIR,
            image_size_bytes: u64::from(workspace_disk_mb) * 1024 * 1024,
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(hit.result(), WorkspaceCacheCheckoutResult::Hit);
    let seed = hit
        .workspace_drive_config()
        .and_then(|config| config.seed_image)
        .expect("seeded workspace cache should produce a seed image");
    drop(hit);
    seed
}
