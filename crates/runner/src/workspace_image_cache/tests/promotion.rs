use std::os::unix::fs::MetadataExt;

use tokio::fs;

use super::super::fs::local_timestamp;
use super::super::{
    SessionWorkspaceCache, WorkspaceCacheCheckoutResult, WorkspaceCacheTerminalStatus,
    WorkspaceImageLeaseIdentity, WorkspaceImagePrepareRequest,
    WorkspaceImagePromotionIdentityMismatch, WorkspaceImagePromotionIdentityRequest,
    WorkspaceImagePromotionOutcome, WorkspaceImagePromotionRequest,
};
use super::support::{
    TEST_PROFILE_NAME, local_cache, promote_current_cache_entry, write_current_cache_entry,
};
use crate::error::RunnerError;
use crate::ids::RunId;
use crate::paths::{RunnerPaths, session_workspace_cache_key};
use crate::storage_fingerprints::StorageFingerprints;

#[tokio::test]
async fn promotion_does_not_overwrite_newer_cache_entry() {
    let (_dir, paths, cache) = local_cache().await;
    let session_id = "sess-race";
    let existing_image = format!("image-{session_id}").into_bytes();
    let image_size = existing_image.len() as u64;
    let stale_run_id = RunId::new_v4();
    let stale_sandbox_id = sandbox::SandboxId::new_v4();
    let stale_lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: stale_run_id,
                sandbox_id: stale_sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                cli_agent_session_id: Some(session_id),
                working_dir: "/workspace",
                image_size_bytes: image_size,
            },
            workspace_drive_required: false,
        })
        .await;
    assert_eq!(stale_lease.result(), WorkspaceCacheCheckoutResult::Miss);
    let stale_active_image = paths.active_workspace_image(&stale_sandbox_id);
    tokio::fs::create_dir_all(stale_active_image.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&stale_active_image, vec![b'o'; image_size as usize])
        .await
        .unwrap();
    let key = write_current_cache_entry(
        &cache,
        stale_run_id,
        session_id,
        "/workspace",
        "2026-06-02T00:00:00.000Z",
        "2026-06-02T00:00:00.000Z",
    )
    .await;

    let promoted = stale_lease
        .promote(
            stale_run_id,
            None,
            WorkspaceCacheTerminalStatus::Success,
            "2026-06-01T00:00:00.000Z".into(),
            &StorageFingerprints::default(),
        )
        .await
        .unwrap();

    assert!(!promoted);
    let metadata = cache
        .read_metadata_file(&paths.session_workspace_cache_metadata(&key))
        .await
        .unwrap();
    assert_eq!(metadata.last_completed_at, "2026-06-02T00:00:00.000Z");
    let current = tokio::fs::read(paths.session_workspace_cache_current_image(&key))
        .await
        .unwrap();
    assert_eq!(current, existing_image);
}

#[tokio::test]
async fn promotion_does_not_overwrite_same_completed_at_cache_entry() {
    let (_dir, paths, cache) = local_cache().await;
    let session_id = "sess-same-completed-at";
    let completed_at = "2026-06-02T00:00:00.000Z";
    let existing_image = format!("image-{session_id}").into_bytes();
    let image_size = existing_image.len() as u64;
    let competing_run_id = RunId::new_v4();
    let competing_sandbox_id = sandbox::SandboxId::new_v4();
    let competing_lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: competing_run_id,
                sandbox_id: competing_sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                cli_agent_session_id: Some(session_id),
                working_dir: "/workspace",
                image_size_bytes: image_size,
            },
            workspace_drive_required: false,
        })
        .await;
    assert_eq!(competing_lease.result(), WorkspaceCacheCheckoutResult::Miss);
    let competing_active_image = paths.active_workspace_image(&competing_sandbox_id);
    tokio::fs::create_dir_all(competing_active_image.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&competing_active_image, vec![b'n'; image_size as usize])
        .await
        .unwrap();
    let key = write_current_cache_entry(
        &cache,
        competing_run_id,
        session_id,
        "/workspace",
        completed_at,
        completed_at,
    )
    .await;

    let promoted = competing_lease
        .promote(
            competing_run_id,
            None,
            WorkspaceCacheTerminalStatus::Success,
            completed_at.into(),
            &StorageFingerprints::default(),
        )
        .await
        .unwrap();

    assert!(!promoted);
    let metadata = cache
        .read_metadata_file(&paths.session_workspace_cache_metadata(&key))
        .await
        .unwrap();
    assert_eq!(metadata.last_completed_at, completed_at);
    let current = tokio::fs::read(paths.session_workspace_cache_current_image(&key))
        .await
        .unwrap();
    assert_eq!(current, existing_image);
}

#[tokio::test]
async fn promotion_overwrites_older_cache_entry() {
    let (_dir, paths, cache) = local_cache().await;
    let session_id = "sess-newer";
    let image_size = b"old image".len() as u64;
    let key = promote_current_cache_entry(
        &cache,
        &paths,
        session_id,
        b"old image",
        "2026-06-01T00:00:00.000Z",
    )
    .await;
    let newer_run_id = RunId::new_v4();
    let newer_sandbox_id = sandbox::SandboxId::new_v4();
    let newer_lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: newer_run_id,
                sandbox_id: newer_sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                cli_agent_session_id: Some(session_id),
                working_dir: "/workspace",
                image_size_bytes: image_size,
            },
            workspace_drive_required: false,
        })
        .await;
    assert!(newer_lease.is_cache_hit());
    let newer_active_image = paths.active_workspace_image(&newer_sandbox_id);
    tokio::fs::create_dir_all(newer_active_image.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&newer_active_image, b"new image")
        .await
        .unwrap();

    let promoted = newer_lease
        .promote(
            newer_run_id,
            None,
            WorkspaceCacheTerminalStatus::Success,
            "2026-06-02T00:00:00.000Z".into(),
            &StorageFingerprints::default(),
        )
        .await
        .unwrap();

    assert!(promoted);
    let metadata = cache
        .read_metadata_file(&paths.session_workspace_cache_metadata(&key))
        .await
        .unwrap();
    assert_eq!(metadata.last_completed_at, "2026-06-02T00:00:00.000Z");
    let current = tokio::fs::read(paths.session_workspace_cache_current_image(&key))
        .await
        .unwrap();
    assert_eq!(current, b"new image");
}

#[tokio::test]
async fn successful_multi_entry_promotion_scans_cache_root_once() {
    let (_dir, paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let first_key = write_current_cache_entry(
        &cache,
        run_id,
        "sess-existing-1",
        "/workspace",
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let second_key = write_current_cache_entry(
        &cache,
        run_id,
        "sess-existing-2",
        "/workspace",
        "2026-05-01T00:01:00.000Z",
        "2026-05-01T00:01:00.000Z",
    )
    .await;
    cache.reset_gc_root_scan_count();

    let promoted_key = promote_current_cache_entry(
        &cache,
        &paths,
        "sess-promoted",
        b"promoted image",
        "2026-05-01T00:02:00.000Z",
    )
    .await;

    assert_eq!(
        cache.gc_root_scan_count(),
        1,
        "successful promotion should inventory the cache root once during mandatory post-promotion GC"
    );
    for cache_key in [first_key, second_key, promoted_key] {
        assert!(
            paths
                .session_workspace_cache_current_image(&cache_key)
                .exists(),
            "healthy under-budget entries should remain after post-promotion GC"
        );
    }
}

#[tokio::test]
async fn abandoned_cache_hit_promotion_context_invalidates_consumed_entry() {
    let (_dir, paths, cache) = local_cache().await;
    let session_id = "sess-abandon-hit";
    let cache_run_id = RunId::new_v4();
    let cache_key = write_current_cache_entry(
        &cache,
        cache_run_id,
        session_id,
        "/workspace",
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let current = paths.session_workspace_cache_current_image(&cache_key);
    let image_size_bytes = fs::metadata(&current).await.unwrap().len();
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                cli_agent_session_id: Some(session_id),
                working_dir: "/workspace",
                image_size_bytes,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Hit);
    assert!(lease.consumed_cache_hit);
    assert!(
        !fs::try_exists(paths.session_workspace_cache_metadata(&cache_key))
            .await
            .unwrap()
    );
    let promotion = lease
        .into_promotion_context(WorkspaceImagePromotionRequest {
            run_id,
            sandbox_id,
            cli_agent_session_id_override: None,
            restored_session_identity: None,
            terminal_status: WorkspaceCacheTerminalStatus::Success,
            completed_at: "2026-05-02T00:00:00.000Z".into(),
            storage_fingerprints: StorageFingerprints::default(),
        })
        .unwrap();

    assert!(
        promotion
            .abandon_unpublished("test abandoned cache hit")
            .await
            .unwrap()
    );
    assert!(
        !fs::try_exists(paths.session_workspace_cache_entry_dir(&cache_key))
            .await
            .unwrap()
    );

    let next = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                cli_agent_session_id: Some(session_id),
                working_dir: "/workspace",
                image_size_bytes,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(next.result(), WorkspaceCacheCheckoutResult::Miss);
}

#[tokio::test]
async fn promotion_context_preserves_existing_newer_cache_entry() {
    let (_dir, paths, cache) = local_cache().await;
    let session_id = "sess-preserve-existing";
    let cache_key = write_current_cache_entry(
        &cache,
        RunId::new_v4(),
        session_id,
        "/workspace",
        "2026-05-02T00:00:00.000Z",
        "2026-05-02T00:00:00.000Z",
    )
    .await;
    let image_size_bytes = format!("image-{session_id}").len() as u64;
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                cli_agent_session_id: None,
                working_dir: "/workspace",
                image_size_bytes,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::NoSession);
    let promotion = lease
        .into_promotion_context(WorkspaceImagePromotionRequest {
            run_id,
            sandbox_id,
            cli_agent_session_id_override: Some(session_id),
            restored_session_identity: None,
            terminal_status: WorkspaceCacheTerminalStatus::Success,
            completed_at: "2026-05-01T00:00:00.000Z".into(),
            storage_fingerprints: StorageFingerprints::default(),
        })
        .unwrap();

    let outcome = promotion.promote().await.unwrap();

    assert_eq!(outcome, WorkspaceImagePromotionOutcome::PreservedExisting);
    drop(promotion);
    let metadata = cache
        .read_metadata_file(&paths.session_workspace_cache_metadata(&cache_key))
        .await
        .unwrap();
    assert_eq!(metadata.last_completed_at, "2026-05-02T00:00:00.000Z");
    assert!(
        fs::try_exists(paths.session_workspace_cache_current_image(&cache_key))
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn no_lock_promotion_context_abandonment_preserves_existing_entry() {
    let (_dir, paths, cache) = local_cache().await;
    let session_id = "sess-no-lock-abandon";
    let cache_key = write_current_cache_entry(
        &cache,
        RunId::new_v4(),
        session_id,
        "/workspace",
        "2026-05-02T00:00:00.000Z",
        "2026-05-02T00:00:00.000Z",
    )
    .await;
    let image_size_bytes = format!("image-{session_id}").len() as u64;
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                cli_agent_session_id: None,
                working_dir: "/workspace",
                image_size_bytes,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::NoSession);
    let promotion = lease
        .into_promotion_context(WorkspaceImagePromotionRequest {
            run_id,
            sandbox_id,
            cli_agent_session_id_override: Some(session_id),
            restored_session_identity: None,
            terminal_status: WorkspaceCacheTerminalStatus::Success,
            completed_at: "2026-05-01T00:00:00.000Z".into(),
            storage_fingerprints: StorageFingerprints::default(),
        })
        .unwrap();

    assert!(
        !promotion
            .abandon_unpublished("test no lock abandon")
            .await
            .unwrap()
    );
    assert!(
        fs::try_exists(paths.session_workspace_cache_metadata(&cache_key))
            .await
            .unwrap()
    );
    assert!(
        fs::try_exists(paths.session_workspace_cache_current_image(&cache_key))
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn consumed_cache_hit_promotion_copies_active_image_back_to_cache() {
    let (_dir, paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let key = write_current_cache_entry(
        &cache,
        run_id,
        "sess-move-promote",
        "/workspace",
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let current = paths.session_workspace_cache_current_image(&key);
    let image_size = fs::metadata(&current).await.unwrap().len();
    let active_image = paths.active_workspace_image(&sandbox_id);

    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                cli_agent_session_id: Some("sess-move-promote"),
                working_dir: "/workspace",
                image_size_bytes: image_size,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Hit);
    fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    fs::rename(&current, &active_image).await.unwrap();
    let updated = vec![b'x'; image_size as usize];
    fs::write(&active_image, &updated).await.unwrap();

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
            .unwrap()
    );

    assert_eq!(fs::read(&active_image).await.unwrap(), updated);
    assert_eq!(fs::read(&current).await.unwrap(), updated);
    let active_metadata = fs::metadata(&active_image).await.unwrap();
    let current_metadata = fs::metadata(&current).await.unwrap();
    assert_ne!(
        (active_metadata.dev(), active_metadata.ino()),
        (current_metadata.dev(), current_metadata.ino()),
        "published cache image must not share an inode with a sandbox that has not been destroyed yet"
    );
    let metadata = cache
        .read_metadata_file(&paths.session_workspace_cache_metadata(&key))
        .await
        .unwrap();
    assert_eq!(metadata.logical_image_size_bytes, image_size);
    assert_eq!(metadata.last_completed_at, "2026-05-02T00:00:00.000Z");
}

#[tokio::test]
async fn lock_busy_checkout_cannot_promote_without_entry_lock() {
    let (_dir, paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let cache_key = cache.scoped_cache_key(TEST_PROFILE_NAME, "sess-1", "/workspace", 1024);
    let _held_lock = crate::lock::acquire(cache.entry_lock_path(&cache_key))
        .await
        .unwrap();

    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                cli_agent_session_id: Some("sess-1"),
                working_dir: "/workspace",
                image_size_bytes: 1024,
            },
            workspace_drive_required: false,
        })
        .await;

    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::LockBusy);
    assert!(
        !lease
            .promote(
                run_id,
                None,
                WorkspaceCacheTerminalStatus::Success,
                local_timestamp(),
                &StorageFingerprints::default(),
            )
            .await
            .unwrap()
    );
    assert!(
        !paths
            .session_workspace_cache_current_image(&cache_key)
            .exists()
    );
}

#[tokio::test]
async fn promotion_context_keeps_entry_locked_until_reused_active_lease_drops() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let session_id = "sess-locked-context";
    let image_size_bytes = 16 * 1024 * 1024;

    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                cli_agent_session_id: Some(session_id),
                working_dir: "/workspace",
                image_size_bytes,
            },
            workspace_drive_required: false,
        })
        .await;
    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Miss);

    let promotion = lease
        .into_promotion_context(WorkspaceImagePromotionRequest {
            run_id,
            sandbox_id,
            cli_agent_session_id_override: Some(session_id),
            restored_session_identity: None,
            terminal_status: WorkspaceCacheTerminalStatus::Success,
            completed_at: local_timestamp(),
            storage_fingerprints: StorageFingerprints::default(),
        })
        .unwrap();

    let blocked_by_context = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                cli_agent_session_id: Some(session_id),
                working_dir: "/workspace",
                image_size_bytes,
            },
            workspace_drive_required: false,
        })
        .await;
    assert_eq!(
        blocked_by_context.result(),
        WorkspaceCacheCheckoutResult::LockBusy
    );

    let expected = cache
        .expected_promotion_identity(WorkspaceImagePromotionIdentityRequest {
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: session_id,
            working_dir: "/workspace",
            image_size_bytes,
        })
        .unwrap();
    let active_lease = promotion.try_into_active_lease(&expected, true).unwrap();

    let blocked_by_active_lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                cli_agent_session_id: Some(session_id),
                working_dir: "/workspace",
                image_size_bytes,
            },
            workspace_drive_required: false,
        })
        .await;
    assert_eq!(
        blocked_by_active_lease.result(),
        WorkspaceCacheCheckoutResult::LockBusy
    );

    drop(active_lease);
    let after_drop = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                cli_agent_session_id: Some(session_id),
                working_dir: "/workspace",
                image_size_bytes,
            },
            workspace_drive_required: false,
        })
        .await;
    assert_eq!(after_drop.result(), WorkspaceCacheCheckoutResult::Miss);
}

#[tokio::test]
async fn promotion_context_validates_expected_identity() {
    let (_dir, paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let session_id = "sess-identity";
    let image_size_bytes = 16 * 1024 * 1024;

    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                cli_agent_session_id: Some(session_id),
                working_dir: "/workspace//repo/",
                image_size_bytes,
            },
            workspace_drive_required: false,
        })
        .await;
    let promotion = lease
        .into_promotion_context(WorkspaceImagePromotionRequest {
            run_id,
            sandbox_id,
            cli_agent_session_id_override: Some(session_id),
            restored_session_identity: None,
            terminal_status: WorkspaceCacheTerminalStatus::Success,
            completed_at: local_timestamp(),
            storage_fingerprints: StorageFingerprints::default(),
        })
        .unwrap();

    let expected = cache
        .expected_promotion_identity(WorkspaceImagePromotionIdentityRequest {
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: session_id,
            working_dir: "/workspace/repo",
            image_size_bytes,
        })
        .unwrap();
    assert_eq!(promotion.validate_identity(&expected), Ok(()));

    let wrong_sandbox = cache
        .expected_promotion_identity(WorkspaceImagePromotionIdentityRequest {
            sandbox_id: sandbox::SandboxId::new_v4(),
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: session_id,
            working_dir: "/workspace/repo",
            image_size_bytes,
        })
        .unwrap();
    assert_eq!(
        promotion.validate_identity(&wrong_sandbox),
        Err(WorkspaceImagePromotionIdentityMismatch::SandboxId),
    );

    let wrong_session = cache
        .expected_promotion_identity(WorkspaceImagePromotionIdentityRequest {
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: "sess-other",
            working_dir: "/workspace/repo",
            image_size_bytes,
        })
        .unwrap();
    assert_eq!(
        promotion.validate_identity(&wrong_session),
        Err(WorkspaceImagePromotionIdentityMismatch::CliAgentSessionId),
    );

    let wrong_size = cache
        .expected_promotion_identity(WorkspaceImagePromotionIdentityRequest {
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: session_id,
            working_dir: "/workspace/repo",
            image_size_bytes: image_size_bytes + 1,
        })
        .unwrap();
    assert_eq!(
        promotion.validate_identity(&wrong_size),
        Err(WorkspaceImagePromotionIdentityMismatch::ImageSizeBytes),
    );

    let scoped_cache = SessionWorkspaceCache::with_cache_dirs(
        paths.clone(),
        paths.workspace_image_cache_dir(),
        paths.base_dir().join("locks"),
        "other-scope",
    );
    let wrong_cache_key = scoped_cache
        .expected_promotion_identity(WorkspaceImagePromotionIdentityRequest {
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: session_id,
            working_dir: "/workspace/repo",
            image_size_bytes,
        })
        .unwrap();
    assert_eq!(
        promotion.validate_identity(&wrong_cache_key),
        Err(WorkspaceImagePromotionIdentityMismatch::CacheKey),
    );

    assert_eq!(
        cache.expected_promotion_identity(WorkspaceImagePromotionIdentityRequest {
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: session_id,
            working_dir: "/",
            image_size_bytes,
        }),
        Err(WorkspaceImagePromotionIdentityMismatch::UnsafeWorkingDir),
    );
}

#[tokio::test]
async fn promote_skips_symlink_active_image_without_following_it() {
    let (dir, paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let session_id = "sess-active-symlink";
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                cli_agent_session_id: Some(session_id),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: false,
        })
        .await;
    let active_image = paths.active_workspace_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    let outside_image = dir.path().join("outside-active.ext4");
    tokio::fs::write(&outside_image, b"image").await.unwrap();
    std::os::unix::fs::symlink(&outside_image, &active_image).unwrap();

    let promoted = lease
        .promote(
            run_id,
            None,
            WorkspaceCacheTerminalStatus::Success,
            "2026-05-01T00:00:00.000Z".into(),
            &StorageFingerprints::default(),
        )
        .await
        .unwrap();

    let cache_key = session_workspace_cache_key(session_id, "/workspace");
    assert!(!promoted);
    assert!(
        !paths
            .session_workspace_cache_current_image(&cache_key)
            .exists()
    );
    assert_eq!(tokio::fs::read(&outside_image).await.unwrap(), b"image");
    assert!(
        tokio::fs::symlink_metadata(&active_image)
            .await
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

#[tokio::test]
async fn promote_replaces_symlink_cache_entry_dir_without_following_it() {
    let (dir, paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let session_id = "sess-promote-entry-symlink";
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                cli_agent_session_id: Some(session_id),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: false,
        })
        .await;
    let active_image = paths.active_workspace_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&active_image, b"image").await.unwrap();
    let cache_key = session_workspace_cache_key(session_id, "/workspace");
    let entry_dir = paths.session_workspace_cache_entry_dir(&cache_key);
    let outside_entry = dir.path().join("outside-promotion-entry");
    tokio::fs::create_dir_all(&outside_entry).await.unwrap();
    tokio::fs::write(outside_entry.join("marker"), b"marker")
        .await
        .unwrap();
    tokio::fs::create_dir_all(entry_dir.parent().unwrap())
        .await
        .unwrap();
    std::os::unix::fs::symlink(&outside_entry, &entry_dir).unwrap();

    let promoted = lease
        .promote(
            run_id,
            None,
            WorkspaceCacheTerminalStatus::Success,
            "2026-05-01T00:00:00.000Z".into(),
            &StorageFingerprints::default(),
        )
        .await
        .unwrap();

    let entry_metadata = fs::symlink_metadata(&entry_dir).await.unwrap();
    assert!(promoted);
    assert!(entry_metadata.is_dir());
    assert!(!entry_metadata.file_type().is_symlink());
    assert_eq!(
        fs::read(paths.session_workspace_cache_current_image(&cache_key))
            .await
            .unwrap(),
        b"image"
    );
    assert!(!outside_entry.join("current.ext4").exists());
    assert_eq!(
        fs::read(outside_entry.join("marker")).await.unwrap(),
        b"marker"
    );
}

#[tokio::test]
async fn promote_removes_current_image_when_metadata_write_fails() {
    let (_dir, paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                cli_agent_session_id: None,
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: false,
        })
        .await;
    tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
        .await
        .unwrap();
    tokio::fs::write(paths.active_workspace_image(&sandbox_id), b"image")
        .await
        .unwrap();

    let cache_key = session_workspace_cache_key("sess-1", "/workspace");
    let metadata_path = paths.session_workspace_cache_metadata(&cache_key);
    tokio::fs::create_dir_all(&metadata_path).await.unwrap();

    let err = lease
        .promote(
            run_id,
            Some("sess-1"),
            WorkspaceCacheTerminalStatus::Success,
            "2026-05-01T00:00:00.000Z".into(),
            &StorageFingerprints::default(),
        )
        .await
        .unwrap_err();

    assert!(matches!(err, RunnerError::Io(_)));
    assert!(
        !paths
            .session_workspace_cache_current_image(&cache_key)
            .exists()
    );
    assert!(
        !paths
            .session_workspace_cache_tmp_image(&cache_key, run_id)
            .exists()
    );
    assert!(
        !metadata_path
            .with_file_name(format!("metadata.json.tmp.{run_id}"))
            .exists()
    );
}

#[tokio::test]
async fn promote_removes_stale_temporary_directory_before_copy() {
    let (_dir, paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                cli_agent_session_id: None,
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: false,
        })
        .await;
    tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
        .await
        .unwrap();
    tokio::fs::write(paths.active_workspace_image(&sandbox_id), b"image")
        .await
        .unwrap();
    let cache_key = session_workspace_cache_key("sess-1", "/workspace");
    let tmp = paths.session_workspace_cache_tmp_image(&cache_key, run_id);
    tokio::fs::create_dir_all(&tmp).await.unwrap();
    tokio::fs::write(tmp.join("stale"), b"stale").await.unwrap();

    assert!(
        lease
            .promote(
                run_id,
                Some("sess-1"),
                WorkspaceCacheTerminalStatus::Success,
                "2026-05-01T00:00:00.000Z".into(),
                &StorageFingerprints::default(),
            )
            .await
            .unwrap()
    );

    let current = paths.session_workspace_cache_current_image(&cache_key);
    assert!(!tmp.exists());
    assert!(fs::metadata(&current).await.unwrap().is_file());
    assert_eq!(fs::read(current).await.unwrap(), b"image");
}

#[tokio::test]
async fn promote_replaces_stale_current_directory_before_rename() {
    let (_dir, paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                cli_agent_session_id: None,
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: false,
        })
        .await;
    tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
        .await
        .unwrap();
    tokio::fs::write(paths.active_workspace_image(&sandbox_id), b"image")
        .await
        .unwrap();
    let cache_key = session_workspace_cache_key("sess-1", "/workspace");
    let current = paths.session_workspace_cache_current_image(&cache_key);
    tokio::fs::create_dir_all(&current).await.unwrap();
    tokio::fs::write(current.join("stale"), b"stale")
        .await
        .unwrap();

    assert!(
        lease
            .promote(
                run_id,
                Some("sess-1"),
                WorkspaceCacheTerminalStatus::Success,
                "2026-05-01T00:00:00.000Z".into(),
                &StorageFingerprints::default(),
            )
            .await
            .unwrap()
    );

    assert!(fs::metadata(&current).await.unwrap().is_file());
    assert_eq!(fs::read(current).await.unwrap(), b"image");
}

#[tokio::test]
async fn promote_skips_copied_image_with_unexpected_logical_size() {
    let (_dir, paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                cli_agent_session_id: Some("sess-size-mismatch"),
                working_dir: "/workspace",
                image_size_bytes: 16 * 1024 * 1024,
            },
            workspace_drive_required: false,
        })
        .await;
    tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
        .await
        .unwrap();
    tokio::fs::write(paths.active_workspace_image(&sandbox_id), b"truncated")
        .await
        .unwrap();
    let cache_key = session_workspace_cache_key("sess-size-mismatch", "/workspace");

    assert!(
        !lease
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
    assert!(
        !paths
            .session_workspace_cache_current_image(&cache_key)
            .exists()
    );
    assert!(cache.held_session_states().await.is_empty());
}

#[tokio::test]
async fn promote_skips_when_capacity_lock_is_busy() {
    let (_dir, paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                cli_agent_session_id: Some("sess-capacity-lock"),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: false,
        })
        .await;
    tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
        .await
        .unwrap();
    tokio::fs::write(paths.active_workspace_image(&sandbox_id), b"image")
        .await
        .unwrap();
    let cache_key = session_workspace_cache_key("sess-capacity-lock", "/workspace");
    let _capacity_lock = crate::lock::acquire(cache.capacity_lock_path())
        .await
        .unwrap();

    let promoted = lease
        .promote(
            run_id,
            None,
            WorkspaceCacheTerminalStatus::Success,
            "2026-05-01T00:00:00.000Z".into(),
            &StorageFingerprints::default(),
        )
        .await
        .unwrap();

    assert!(!promoted);
    assert!(
        !paths
            .session_workspace_cache_current_image(&cache_key)
            .exists()
    );
    assert!(cache.held_session_states().await.is_empty());
}

#[tokio::test]
async fn no_session_checkout_without_late_cli_agent_session_id_has_no_promotion_context() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths);
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                cli_agent_session_id: None,
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: false,
        })
        .await;

    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::NoSession);
    assert!(
        lease
            .into_promotion_context(WorkspaceImagePromotionRequest {
                run_id,
                sandbox_id,
                cli_agent_session_id_override: None,
                restored_session_identity: None,
                terminal_status: WorkspaceCacheTerminalStatus::Success,
                completed_at: "2026-05-01T00:00:00.000Z".into(),
                storage_fingerprints: StorageFingerprints::default(),
            })
            .is_none(),
        "workspace image promotion must wait until a CLI agent session id is available"
    );
}

#[tokio::test]
async fn no_session_checkout_can_promote_with_late_discovered_cli_agent_session_id() {
    let (_dir, paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                cli_agent_session_id: None,
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: false,
        })
        .await;
    tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
        .await
        .unwrap();
    tokio::fs::write(paths.active_workspace_image(&sandbox_id), b"image")
        .await
        .unwrap();

    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::NoSession);
    assert!(
        lease
            .promote(
                run_id,
                Some("sess-1"),
                WorkspaceCacheTerminalStatus::Success,
                "2026-05-01T00:00:00.000Z".into(),
                &StorageFingerprints::default(),
            )
            .await
            .unwrap()
    );

    let cache_key = session_workspace_cache_key("sess-1", "/workspace");
    assert!(
        paths
            .session_workspace_cache_current_image(&cache_key)
            .exists()
    );
    let metadata = cache
        .read_metadata_file(&paths.session_workspace_cache_metadata(&cache_key))
        .await
        .unwrap();
    assert_eq!(metadata.session_id, "sess-1");
    assert_eq!(metadata.working_dir, "/workspace");
    assert_eq!(metadata.logical_image_size_bytes, 5);
}

#[tokio::test]
async fn late_session_promotion_skips_when_entry_lock_is_busy() {
    let (_dir, paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let session_id = "sess-late-lock-busy";
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                cli_agent_session_id: None,
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: false,
        })
        .await;
    tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
        .await
        .unwrap();
    tokio::fs::write(paths.active_workspace_image(&sandbox_id), b"image")
        .await
        .unwrap();
    let promotion = lease
        .into_promotion_context(WorkspaceImagePromotionRequest {
            run_id,
            sandbox_id,
            cli_agent_session_id_override: Some(session_id),
            restored_session_identity: None,
            terminal_status: WorkspaceCacheTerminalStatus::Success,
            completed_at: "2026-05-01T00:00:00.000Z".into(),
            storage_fingerprints: StorageFingerprints::default(),
        })
        .unwrap();
    let cache_key = session_workspace_cache_key(session_id, "/workspace");
    let _held_lock = crate::lock::acquire(cache.entry_lock_path(&cache_key))
        .await
        .unwrap();

    let outcome = tokio::time::timeout(std::time::Duration::from_secs(1), promotion.promote())
        .await
        .expect("late-session promotion must not block behind another runner's lock")
        .unwrap();

    assert_eq!(outcome, WorkspaceImagePromotionOutcome::SkippedUnpublished);
    assert!(
        !paths
            .session_workspace_cache_current_image(&cache_key)
            .exists()
    );
}

#[tokio::test]
async fn no_lock_promotion_context_survives_reuse_active_lease() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths);
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let session_id = "sess-reused-late-context";
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                cli_agent_session_id: None,
                working_dir: "/workspace//repo/",
                image_size_bytes: 5,
            },
            workspace_drive_required: false,
        })
        .await;
    let promotion = lease
        .into_promotion_context(WorkspaceImagePromotionRequest {
            run_id,
            sandbox_id,
            cli_agent_session_id_override: Some(session_id),
            restored_session_identity: None,
            terminal_status: WorkspaceCacheTerminalStatus::Success,
            completed_at: "2026-05-01T00:00:00.000Z".into(),
            storage_fingerprints: StorageFingerprints::default(),
        })
        .unwrap();

    let expected = cache
        .expected_promotion_identity(WorkspaceImagePromotionIdentityRequest {
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: session_id,
            working_dir: "/workspace//repo/",
            image_size_bytes: 5,
        })
        .unwrap();
    let active_lease = promotion.try_into_active_lease(&expected, true).unwrap();

    assert_eq!(active_lease.working_dir(), "/workspace/repo");
    assert!(
        active_lease
            .into_promotion_context(WorkspaceImagePromotionRequest {
                run_id: RunId::new_v4(),
                sandbox_id,
                cli_agent_session_id_override: Some(session_id),
                restored_session_identity: None,
                terminal_status: WorkspaceCacheTerminalStatus::Success,
                completed_at: "2026-05-01T00:00:01.000Z".into(),
                storage_fingerprints: StorageFingerprints::default(),
            })
            .is_some(),
        "reusing an idle sandbox created before the CLI reported a session id must not lose the future cache promotion"
    );
}
