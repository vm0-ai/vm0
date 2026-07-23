use tokio::fs;

use super::super::fs::{allocated_bytes, local_timestamp};
use super::super::metadata::{
    WorkspaceCacheMetadata, WorkspaceCacheState, WorkspaceImageFileIdentity, WorkspaceTrust,
};
use super::super::{
    CACHE_FORMAT_VERSION, CACHE_KEY_VERSION, SessionWorkspaceCache, WORKSPACE_DRIVE_LAYOUT,
    WorkspaceCacheCheckoutResult, WorkspaceCacheTerminalStatus, WorkspaceImageLeaseIdentity,
    WorkspaceImagePrepareRequest,
};
use super::support::{TEST_PROFILE_NAME, local_cache};
use crate::ids::RunId;
use crate::paths::RunnerPaths;
use crate::storage_fingerprints::StorageFingerprints;

#[tokio::test]
async fn prepare_removes_symlink_cache_entry_without_following_it() {
    let (dir, paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let session_id = "sess-entry-symlink";
    let key = cache.scoped_cache_key(TEST_PROFILE_NAME, session_id, "/workspace", 5);
    let outside_entry = dir.path().join("outside-cache-entry");
    fs::create_dir_all(&outside_entry).await.unwrap();
    let outside_current = outside_entry.join("current.ext4");
    fs::write(&outside_current, b"image").await.unwrap();
    let current_metadata = fs::metadata(&outside_current).await.unwrap();
    let metadata = WorkspaceCacheMetadata {
        format_version: CACHE_FORMAT_VERSION,
        key_version: CACHE_KEY_VERSION,
        cache_scope: cache.inner.cache_scope.clone(),
        profile_name: TEST_PROFILE_NAME.into(),
        session_id: session_id.into(),
        working_dir: "/workspace".into(),
        last_completed_at: "2026-05-01T00:00:00.000Z".into(),
        last_used_at: "2026-05-01T00:00:00.000Z".into(),
        last_terminal_status: WorkspaceCacheTerminalStatus::Success,
        workspace_trust: WorkspaceTrust::Clean,
        logical_image_size_bytes: current_metadata.len(),
        allocated_bytes: allocated_bytes(&current_metadata),
        current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
        drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
        storage_fingerprints: StorageFingerprints::default(),
        state: WorkspaceCacheState::Current,
    };
    fs::write(
        outside_entry.join("metadata.json"),
        serde_json::to_vec_pretty(&metadata).unwrap(),
    )
    .await
    .unwrap();
    let entry_dir = paths.session_workspace_cache_entry_dir(&key);
    fs::create_dir_all(entry_dir.parent().unwrap())
        .await
        .unwrap();
    std::os::unix::fs::symlink(&outside_entry, &entry_dir).unwrap();

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
            workspace_drive_required: true,
        })
        .await;

    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Miss);
    assert!(
        lease
            .workspace_drive_config()
            .expect("workspace drive should stay enabled")
            .seed_image
            .is_none()
    );
    assert!(matches!(
        fs::symlink_metadata(&entry_dir).await,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound
    ));
    assert_eq!(fs::read(&outside_current).await.unwrap(), b"image");
}

#[tokio::test]
async fn metadata_missing_current_present_is_not_a_cache_hit() {
    let (_dir, paths, cache) = local_cache().await;
    let key = cache.scoped_cache_key(TEST_PROFILE_NAME, "sess-no-metadata", "/workspace", 5);
    fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
        .await
        .unwrap();
    fs::write(paths.session_workspace_cache_current_image(&key), b"image")
        .await
        .unwrap();

    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                cli_agent_session_id: Some("sess-no-metadata"),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: true,
        })
        .await;

    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Miss);
    assert_eq!(
        lease
            .workspace_drive_config()
            .and_then(|config| config.seed_image),
        None
    );
}

#[tokio::test]
async fn metadata_validation_rejects_metadata_mismatch() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().to_path_buf());
    let cache = SessionWorkspaceCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let key = cache.scoped_cache_key(TEST_PROFILE_NAME, "sess-1", "/workspace", 1024);
    fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
        .await
        .unwrap();
    let current = paths.session_workspace_cache_current_image(&key);
    fs::write(&current, b"image").await.unwrap();
    let current_metadata = fs::metadata(&current).await.unwrap();
    cache
        .write_metadata(
            &key,
            run_id,
            WorkspaceCacheMetadata {
                format_version: CACHE_FORMAT_VERSION,
                key_version: CACHE_KEY_VERSION,
                cache_scope: String::new(),
                profile_name: TEST_PROFILE_NAME.into(),
                session_id: "other".into(),
                working_dir: "/workspace".into(),
                last_completed_at: local_timestamp(),
                last_used_at: local_timestamp(),
                last_terminal_status: WorkspaceCacheTerminalStatus::Success,
                workspace_trust: WorkspaceTrust::Clean,
                logical_image_size_bytes: 1024,
                allocated_bytes: 1024,
                current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
                drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
                storage_fingerprints: StorageFingerprints::default(),
                state: WorkspaceCacheState::Current,
            },
        )
        .await
        .unwrap();

    let err = cache
        .read_valid_metadata(
            &paths.session_workspace_cache_metadata(&key),
            TEST_PROFILE_NAME,
            "sess-1",
            "/workspace",
            1024,
        )
        .await;

    assert!(err.unwrap_err().to_string().contains("session id mismatch"));
}

#[tokio::test]
async fn write_metadata_replaces_stale_tmp_symlink_without_following_it() {
    let (dir, paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let key = cache.scoped_cache_key(TEST_PROFILE_NAME, "sess-1", "/workspace", 5);
    fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
        .await
        .unwrap();
    let current = paths.session_workspace_cache_current_image(&key);
    fs::write(&current, b"image").await.unwrap();
    let current_metadata = fs::metadata(&current).await.unwrap();
    let outside = dir.path().join("outside-metadata-target");
    fs::write(&outside, b"outside").await.unwrap();
    let metadata_tmp = paths
        .session_workspace_cache_metadata(&key)
        .with_file_name(format!("metadata.json.tmp.{run_id}"));
    std::os::unix::fs::symlink(&outside, &metadata_tmp).unwrap();

    cache
        .write_metadata(
            &key,
            run_id,
            WorkspaceCacheMetadata {
                format_version: CACHE_FORMAT_VERSION,
                key_version: CACHE_KEY_VERSION,
                cache_scope: String::new(),
                profile_name: TEST_PROFILE_NAME.into(),
                session_id: "sess-1".into(),
                working_dir: "/workspace".into(),
                last_completed_at: "2026-05-01T00:00:00.000Z".into(),
                last_used_at: "2026-05-01T00:01:00.000Z".into(),
                last_terminal_status: WorkspaceCacheTerminalStatus::Success,
                workspace_trust: WorkspaceTrust::Clean,
                logical_image_size_bytes: current_metadata.len(),
                allocated_bytes: allocated_bytes(&current_metadata),
                current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
                drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
                storage_fingerprints: StorageFingerprints::default(),
                state: WorkspaceCacheState::Current,
            },
        )
        .await
        .unwrap();

    assert_eq!(fs::read(&outside).await.unwrap(), b"outside");
    let metadata_path = paths.session_workspace_cache_metadata(&key);
    let metadata_file_type = fs::symlink_metadata(&metadata_path)
        .await
        .unwrap()
        .file_type();
    assert!(metadata_file_type.is_file());
    assert!(!metadata_file_type.is_symlink());
}

#[tokio::test]
async fn prepare_removes_invalid_metadata_entry_and_allows_repromotion() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().to_path_buf());
    let cache = SessionWorkspaceCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let image_size = b"old image".len() as u64;
    let key = cache.scoped_cache_key(TEST_PROFILE_NAME, "sess-1", "/workspace", image_size);
    fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
        .await
        .unwrap();
    let current = paths.session_workspace_cache_current_image(&key);
    fs::write(&current, b"old image").await.unwrap();
    let current_metadata = fs::metadata(&current).await.unwrap();
    cache
        .write_metadata(
            &key,
            run_id,
            WorkspaceCacheMetadata {
                format_version: CACHE_FORMAT_VERSION,
                key_version: CACHE_KEY_VERSION,
                cache_scope: String::new(),
                profile_name: TEST_PROFILE_NAME.into(),
                session_id: "other".into(),
                working_dir: "/workspace".into(),
                last_completed_at: local_timestamp(),
                last_used_at: local_timestamp(),
                last_terminal_status: WorkspaceCacheTerminalStatus::Success,
                workspace_trust: WorkspaceTrust::Clean,
                logical_image_size_bytes: image_size,
                allocated_bytes: allocated_bytes(&current_metadata),
                current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
                drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
                storage_fingerprints: StorageFingerprints::default(),
                state: WorkspaceCacheState::Current,
            },
        )
        .await
        .unwrap();

    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                cli_agent_session_id: Some("sess-1"),
                working_dir: "/workspace",
                image_size_bytes: image_size,
            },
            workspace_drive_required: false,
        })
        .await;

    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Miss);
    assert!(
        !paths.session_workspace_cache_entry_dir(&key).exists(),
        "invalid entry should be removed while the entry lock is held"
    );

    let active_image = paths.active_workspace_image(&sandbox_id);
    fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    fs::write(&active_image, b"new image").await.unwrap();
    assert!(
        lease
            .promote(
                run_id,
                None,
                WorkspaceCacheTerminalStatus::Success,
                "2026-06-01T00:00:00.000Z".into(),
                &StorageFingerprints::default(),
            )
            .await
            .unwrap()
    );

    let metadata = cache
        .read_metadata_file(&paths.session_workspace_cache_metadata(&key))
        .await
        .unwrap();
    assert_eq!(metadata.session_id, "sess-1");
    assert_eq!(cache.held_session_states().await.len(), 1);
}

#[tokio::test]
async fn metadata_validation_rejects_replaced_current_image() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().to_path_buf());
    let cache = SessionWorkspaceCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let key = cache.scoped_cache_key(
        TEST_PROFILE_NAME,
        "sess-1",
        "/workspace",
        b"old image".len() as u64,
    );
    fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
        .await
        .unwrap();
    let current = paths.session_workspace_cache_current_image(&key);
    fs::write(&current, b"old image").await.unwrap();
    let current_metadata = fs::metadata(&current).await.unwrap();
    cache
        .write_metadata(
            &key,
            run_id,
            WorkspaceCacheMetadata {
                format_version: CACHE_FORMAT_VERSION,
                key_version: CACHE_KEY_VERSION,
                cache_scope: String::new(),
                profile_name: TEST_PROFILE_NAME.into(),
                session_id: "sess-1".into(),
                working_dir: "/workspace".into(),
                last_completed_at: local_timestamp(),
                last_used_at: local_timestamp(),
                last_terminal_status: WorkspaceCacheTerminalStatus::Success,
                workspace_trust: WorkspaceTrust::Clean,
                logical_image_size_bytes: current_metadata.len(),
                allocated_bytes: allocated_bytes(&current_metadata),
                current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
                drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
                storage_fingerprints: StorageFingerprints::default(),
                state: WorkspaceCacheState::Current,
            },
        )
        .await
        .unwrap();
    let replacement = paths
        .session_workspace_cache_entry_dir(&key)
        .join("replacement.ext4");
    fs::write(&replacement, b"new image").await.unwrap();
    fs::rename(&replacement, &current).await.unwrap();

    let err = cache
        .read_valid_metadata(
            &paths.session_workspace_cache_metadata(&key),
            TEST_PROFILE_NAME,
            "sess-1",
            "/workspace",
            current_metadata.len(),
        )
        .await
        .unwrap_err();

    assert!(err.to_string().contains("current image identity mismatch"));
    assert!(
        cache.held_session_states().await.is_empty(),
        "stale metadata/current pairs must not be advertised for affinity",
    );
}

#[tokio::test]
async fn metadata_validation_rejects_symlink_current_image() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().to_path_buf());
    let cache = SessionWorkspaceCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let key = cache.scoped_cache_key(
        TEST_PROFILE_NAME,
        "sess-1",
        "/workspace",
        b"image".len() as u64,
    );
    fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
        .await
        .unwrap();
    let target = dir.path().join("target.ext4");
    fs::write(&target, b"image").await.unwrap();
    let current = paths.session_workspace_cache_current_image(&key);
    std::os::unix::fs::symlink(&target, &current).unwrap();
    let current_target_metadata = fs::metadata(&current).await.unwrap();
    cache
        .write_metadata(
            &key,
            run_id,
            WorkspaceCacheMetadata {
                format_version: CACHE_FORMAT_VERSION,
                key_version: CACHE_KEY_VERSION,
                cache_scope: String::new(),
                profile_name: TEST_PROFILE_NAME.into(),
                session_id: "sess-1".into(),
                working_dir: "/workspace".into(),
                last_completed_at: local_timestamp(),
                last_used_at: local_timestamp(),
                last_terminal_status: WorkspaceCacheTerminalStatus::Success,
                workspace_trust: WorkspaceTrust::Clean,
                logical_image_size_bytes: current_target_metadata.len(),
                allocated_bytes: allocated_bytes(&current_target_metadata),
                current_image: WorkspaceImageFileIdentity::from_metadata(&current_target_metadata),
                drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
                storage_fingerprints: StorageFingerprints::default(),
                state: WorkspaceCacheState::Current,
            },
        )
        .await
        .unwrap();

    let err = cache
        .read_valid_metadata(
            &paths.session_workspace_cache_metadata(&key),
            TEST_PROFILE_NAME,
            "sess-1",
            "/workspace",
            current_target_metadata.len(),
        )
        .await
        .unwrap_err();

    assert!(err.to_string().contains("current image is not a file"));
    assert!(
        cache.held_session_states().await.is_empty(),
        "symlink current image entries must not be advertised for affinity",
    );

    let freed = cache.gc(false).await.unwrap();

    assert!(freed > 0);
    assert!(!paths.session_workspace_cache_entry_dir(&key).exists());
    assert!(
        target.exists(),
        "GC must remove the symlink, not its target"
    );
}
