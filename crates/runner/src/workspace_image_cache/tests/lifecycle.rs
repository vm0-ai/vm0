use tokio::fs;

use super::super::fs::{allocated_bytes, local_timestamp};
use super::super::metadata::{
    WorkspaceCacheMetadata, WorkspaceCacheState, WorkspaceImageFileIdentity, WorkspaceTrust,
};
use super::super::{
    CACHE_FORMAT_VERSION, CACHE_KEY_VERSION, CacheBudget, FsStats, SessionWorkspaceCache,
    TEST_FS_TOTAL_BYTES, WORKSPACE_DRIVE_LAYOUT, WorkspaceCacheCheckoutResult,
    WorkspaceCacheTerminalStatus, WorkspaceImageActiveLeaseRequest, WorkspaceImageLeaseIdentity,
    WorkspaceImagePrepareRequest,
};
use super::support::{TEST_PROFILE_NAME, local_cache, write_current_cache_entry};
use crate::ids::RunId;
use crate::paths::{HomePaths, RunnerPaths, session_workspace_cache_key};
use crate::storage_fingerprints::StorageFingerprints;

#[tokio::test]
async fn thread_cache_is_reusable_across_cli_session_rotation() {
    let (_dir, paths, cache) = local_cache().await;
    let reuse_key = "thread:chat-thread";
    let first_run_id = RunId::new_v4();
    let first_sandbox_id = sandbox::SandboxId::new_v4();
    let first = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: first_run_id,
                sandbox_id: first_sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(reuse_key),
                cli_agent_session_id: Some("provider-session-a"),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: false,
        })
        .await;
    assert_eq!(first.result(), WorkspaceCacheCheckoutResult::Miss);
    let active_image = paths.active_workspace_image(&first_sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&active_image, b"image").await.unwrap();
    assert!(
        first
            .promote(
                first_run_id,
                None,
                WorkspaceCacheTerminalStatus::Success,
                "2026-05-01T00:00:00.000Z".into(),
                &StorageFingerprints::default(),
            )
            .await
            .unwrap()
    );

    let rotated = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(reuse_key),
                cli_agent_session_id: Some("provider-session-b"),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: false,
        })
        .await;

    assert_eq!(rotated.result(), WorkspaceCacheCheckoutResult::Hit);
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
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some("sess-1"),
                cli_agent_session_id: Some("sess-1"),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
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

    let checkout = cache_b
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some("sess-1"),
                cli_agent_session_id: Some("sess-1"),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: false,
        })
        .await;

    assert_eq!(checkout.result(), WorkspaceCacheCheckoutResult::Hit);
    let seed = checkout
        .workspace_drive_config()
        .and_then(|config| config.seed_image)
        .expect("shared checkout should seed from the host-level workspace image cache");
    match seed {
        sandbox::WorkspaceDriveSeedImage::Move(path) => assert!(
            path.starts_with(home.workspace_image_cache_dir()),
            "shared checkout must move from the host-level workspace image cache"
        ),
        other => panic!("shared checkout should use a move seed, got {other:?}"),
    }
    let key = cache_b.scoped_cache_key(TEST_PROFILE_NAME, "sess-1", "/workspace", 5);
    assert!(
        !home
            .workspace_image_cache_dir()
            .join(key)
            .join("metadata.json")
            .exists(),
        "move checkout must remove reusable cache metadata"
    );
}

#[tokio::test]
async fn cache_hit_removes_metadata_and_returns_move_seed() {
    let (_dir, paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let key = write_current_cache_entry(
        &cache,
        run_id,
        "sess-move-hit",
        "/workspace",
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let current = paths.session_workspace_cache_current_image(&key);
    let image_size = fs::metadata(&current).await.unwrap().len();

    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some("sess-move-hit"),
                cli_agent_session_id: Some("sess-move-hit"),
                working_dir: "/workspace",
                image_size_bytes: image_size,
            },
            workspace_drive_required: true,
        })
        .await;

    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Hit);
    assert!(lease.consumed_cache_hit);
    assert_eq!(
        lease
            .workspace_drive_config()
            .and_then(|config| config.seed_image),
        Some(sandbox::WorkspaceDriveSeedImage::Move(current.clone()))
    );
    assert!(current.exists());
    assert!(matches!(
        fs::metadata(paths.session_workspace_cache_metadata(&key)).await,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound
    ));
}

#[tokio::test]
async fn consumed_cache_hit_invalidation_tolerates_missing_current() {
    let (_dir, paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let key = write_current_cache_entry(
        &cache,
        run_id,
        "sess-move-invalidate",
        "/workspace",
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let current = paths.session_workspace_cache_current_image(&key);
    let image_size = fs::metadata(&current).await.unwrap().len();

    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some("sess-move-invalidate"),
                cli_agent_session_id: Some("sess-move-invalidate"),
                working_dir: "/workspace",
                image_size_bytes: image_size,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Hit);
    fs::remove_file(&current).await.unwrap();

    assert!(
        lease
            .invalidate(run_id, "test consumed cache hit failure")
            .await
            .unwrap()
    );
    assert!(!paths.session_workspace_cache_entry_dir(&key).exists());
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
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some("sess-1"),
                cli_agent_session_id: Some("sess-1"),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: false,
        })
        .await;
    assert_eq!(lease_a.result(), WorkspaceCacheCheckoutResult::Miss);

    let blocked_checkout = cache_b
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some("sess-1"),
                cli_agent_session_id: Some("sess-1"),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
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
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some("sess-1"),
                cli_agent_session_id: Some("sess-1"),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
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
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some("sess-1"),
                cli_agent_session_id: Some("sess-1"),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
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

    let checkout = cache_b
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some("sess-1"),
                cli_agent_session_id: Some("sess-1"),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: false,
        })
        .await;

    assert_eq!(checkout.result(), WorkspaceCacheCheckoutResult::Miss);
    assert!(checkout.source_image.is_none());
    assert!(
        cache_b.held_workspace_states().await.is_empty(),
        "a runner must not advertise workspace cache entries from another group"
    );
}

#[tokio::test]
async fn cache_hit_checkout_and_same_filesystem_promotion_do_not_require_copy_headroom() {
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
                reuse_key: "sess-1".into(),
                cli_agent_session_id: Some("sess-1".into()),
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
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some("sess-1"),
                cli_agent_session_id: Some("sess-1"),
                working_dir: "/workspace",
                image_size_bytes: current_metadata.len(),
            },
            workspace_drive_required: false,
        })
        .await;

    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Hit);
    assert_eq!(
        lease
            .workspace_drive_config()
            .and_then(|config| config.seed_image),
        Some(sandbox::WorkspaceDriveSeedImage::Move(current.clone()))
    );
    assert!(
        tokio::fs::try_exists(&current).await.unwrap(),
        "move checkout keeps the source in place until sandbox preparation consumes it"
    );
    assert!(
        !tokio::fs::try_exists(paths.session_workspace_cache_metadata(&cache_key))
            .await
            .unwrap(),
        "move checkout removes metadata before handing the current image to sandbox preparation"
    );
    tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
        .await
        .unwrap();
    let active_image = paths.active_workspace_image(&sandbox_id);
    tokio::fs::rename(&current, &active_image).await.unwrap();

    assert!(
        lease
            .promote(
                run_id,
                None,
                WorkspaceCacheTerminalStatus::Success,
                "2026-05-02T00:00:00.000Z".into(),
                &StorageFingerprints::default(),
            )
            .await
            .unwrap(),
        "same-filesystem ownership transfer must not require duplicate-copy headroom"
    );
    assert!(
        tokio::fs::try_exists(&current).await.unwrap(),
        "same-filesystem promotion must publish the moved image"
    );
    assert!(
        !tokio::fs::try_exists(&active_image).await.unwrap(),
        "same-filesystem promotion must consume the active image"
    );
}

#[tokio::test]
async fn active_lease_hides_cached_session_until_dropped() {
    let (_dir, paths, cache) = local_cache().await;
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
                reuse_key: "sess-1".into(),
                cli_agent_session_id: Some("sess-1".into()),
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

    assert_eq!(cache.held_workspace_states().await.len(), 1);

    let lease = cache
        .lease_active(WorkspaceImageActiveLeaseRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some("sess-1"),
                cli_agent_session_id: Some("sess-1"),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_available: true,
        })
        .await;

    assert!(cache.held_workspace_states().await.is_empty());
    drop(lease);
    assert_eq!(cache.held_workspace_states().await.len(), 1);
}
