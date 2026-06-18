use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

use super::fs::{
    allocated_bytes, directory_tree_allocated_bytes, has_copy_headroom, local_timestamp,
    sparse_copy_with_timeout, workspace_cache_path_allocated_bytes,
};
use super::gc::gc_budget_satisfied;
use super::lifecycle::cap_workspace_held_session_states;
use super::metadata::{
    WorkspaceCacheMetadata, WorkspaceCacheState, WorkspaceImageFileIdentity, WorkspaceTrust,
};
use super::path_safety::{
    filter_storage_fingerprints_for_working_dir, is_safe_guest_working_dir,
    normalize_safe_guest_working_dir,
};
use super::*;
use crate::error::RunnerError;
use crate::ids::RunId;
use crate::paths::{RunnerPaths, scoped_session_workspace_cache_key, session_workspace_cache_key};
use crate::storage_fingerprints::StorageFingerprint;
use crate::storage_fingerprints::StorageFingerprints;
use crate::types::{HeldSessionState, MAX_HELD_SESSION_STATES};
use tokio::fs;

const TEST_PROFILE_NAME: &str = "vm0/default";

fn timestamp_for_index(index: usize) -> String {
    format!("2026-05-01T00:{:02}:{:02}.000Z", index / 60, index % 60)
}

fn make_fifo(path: &Path) {
    let c_path = std::ffi::CString::new(path.to_string_lossy().as_bytes()).unwrap();
    // SAFETY: `c_path` is a valid nul-terminated path for `mkfifo`.
    let result = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
    assert_eq!(
        result,
        0,
        "mkfifo failed: {}",
        std::io::Error::last_os_error()
    );
}

async fn write_current_cache_entry(
    cache: &SessionWorkspaceCache,
    run_id: RunId,
    session_id: &str,
    working_dir: &str,
    last_completed_at: &str,
    last_used_at: &str,
) -> String {
    let image = format!("image-{session_id}");
    let key = cache.scoped_cache_key(
        TEST_PROFILE_NAME,
        session_id,
        working_dir,
        image.len() as u64,
    );
    fs::create_dir_all(cache.session_workspace_cache_entry_dir(&key))
        .await
        .unwrap();
    let current = cache.session_workspace_cache_current_image(&key);
    fs::write(&current, image).await.unwrap();
    let current_metadata = fs::metadata(&current).await.unwrap();
    cache
        .write_metadata(
            &key,
            run_id,
            WorkspaceCacheMetadata {
                format_version: CACHE_FORMAT_VERSION,
                key_version: CACHE_KEY_VERSION,
                cache_scope: cache.inner.cache_scope.clone(),
                profile_name: TEST_PROFILE_NAME.into(),
                session_id: session_id.into(),
                working_dir: working_dir.into(),
                last_completed_at: last_completed_at.into(),
                last_used_at: last_used_at.into(),
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
    key
}

async fn promote_current_cache_entry(
    cache: &SessionWorkspaceCache,
    paths: &RunnerPaths,
    session_id: &str,
    image: &[u8],
    last_completed_at: &str,
) -> String {
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id,
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: Some(session_id),
            working_dir: "/workspace",
            image_size_bytes: image.len() as u64,
            workspace_drive_required: false,
        })
        .await;
    let active_image = paths.active_workspace_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&active_image, image).await.unwrap();
    assert!(
        lease
            .promote(
                run_id,
                None,
                WorkspaceCacheTerminalStatus::Success,
                last_completed_at.into(),
                &StorageFingerprints::default(),
            )
            .await
            .unwrap()
    );
    drop(lease);
    cache.scoped_cache_key(
        TEST_PROFILE_NAME,
        session_id,
        "/workspace",
        image.len() as u64,
    )
}

#[tokio::test]
async fn promotion_does_not_overwrite_newer_cache_entry() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let session_id = "sess-race";
    let existing_image = format!("image-{session_id}").into_bytes();
    let image_size = existing_image.len() as u64;
    let stale_run_id = RunId::new_v4();
    let stale_sandbox_id = sandbox::SandboxId::new_v4();
    let stale_lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id: stale_run_id,
            sandbox_id: stale_sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: Some(session_id),
            working_dir: "/workspace",
            image_size_bytes: image_size,
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
    drop(stale_lease);
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
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let session_id = "sess-same-completed-at";
    let completed_at = "2026-06-02T00:00:00.000Z";
    let existing_image = format!("image-{session_id}").into_bytes();
    let image_size = existing_image.len() as u64;
    let competing_run_id = RunId::new_v4();
    let competing_sandbox_id = sandbox::SandboxId::new_v4();
    let competing_lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id: competing_run_id,
            sandbox_id: competing_sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: Some(session_id),
            working_dir: "/workspace",
            image_size_bytes: image_size,
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
    drop(competing_lease);
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
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
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
            run_id: newer_run_id,
            sandbox_id: newer_sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: Some(session_id),
            working_dir: "/workspace",
            image_size_bytes: image_size,
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
    drop(newer_lease);
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

#[test]
fn budget_uses_automatic_bounds() {
    let budget = CacheBudget::from_fs_stats(FsStats {
        total_bytes: 2_000 * GIB,
        available_bytes: 1_000 * GIB,
    });
    assert_eq!(budget.max_cache_bytes, 1_000 * GIB);
    assert_eq!(budget.target_after_gc_bytes, 750 * GIB);
    assert_eq!(budget.min_free_bytes, 200 * GIB);
    assert_eq!(budget.max_entry_bytes, 32 * GIB);
}

#[test]
fn budget_uses_half_of_filesystem_for_smaller_hosts() {
    let budget = CacheBudget::from_fs_stats(FsStats {
        total_bytes: 400 * GIB,
        available_bytes: 300 * GIB,
    });
    assert_eq!(budget.max_cache_bytes, 200 * GIB);
    assert_eq!(budget.target_after_gc_bytes, 150 * GIB);
    assert_eq!(budget.min_free_bytes, 50 * GIB);
    assert_eq!(budget.max_entry_bytes, 20 * GIB);
}

#[test]
fn fs_stats_path_prefers_existing_cache_dir() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    std::fs::create_dir_all(paths.workspace_image_cache_dir()).unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());

    assert_eq!(
        cache.workspace_image_cache_fs_stats_path(),
        paths.workspace_image_cache_dir()
    );
}

#[test]
fn fs_stats_path_falls_back_to_existing_parent_when_cache_dir_is_missing() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    std::fs::create_dir_all(paths.base_dir()).unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());

    assert_eq!(
        cache.workspace_image_cache_fs_stats_path(),
        paths.base_dir().to_path_buf()
    );
}

#[tokio::test]
async fn inspect_missing_cache_dir_returns_empty_summary() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = SessionWorkspaceCache::new(paths);

    let inspection = cache.inspect().await.unwrap();

    assert!(inspection.entries.is_empty());
    assert_eq!(inspection.summary.total_entries, 0);
    assert_eq!(inspection.summary.total_allocated_bytes, 0);
    assert_eq!(inspection.summary.total_logical_image_bytes, 0);
    assert_eq!(inspection.fs_stats.total_bytes, TEST_FS_TOTAL_BYTES);
    assert_eq!(
        inspection.budget,
        CacheBudget::from_fs_stats(inspection.fs_stats)
    );
}

#[tokio::test]
async fn inspect_reports_reusable_entry_with_storage_counts() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let key = cache.scoped_cache_key(TEST_PROFILE_NAME, "sess-1", "/workspace", 5);
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
                storage_fingerprints: StorageFingerprints {
                    storages: HashMap::from([
                        ("/workspace".into(), StorageFingerprint::new("repo", "v1")),
                        (
                            "/workspace/cache".into(),
                            StorageFingerprint::new("cache", "v2"),
                        ),
                    ]),
                    artifacts: HashMap::from([(
                        "/workspace/artifact".into(),
                        StorageFingerprint::new("artifact", "v1"),
                    )]),
                },
                state: WorkspaceCacheState::Current,
            },
        )
        .await
        .unwrap();

    let inspection = cache.inspect().await.unwrap();

    assert_eq!(inspection.summary.total_entries, 1);
    assert_eq!(inspection.summary.reusable_entries, 1);
    assert_eq!(inspection.summary.total_logical_image_bytes, 5);
    assert!(inspection.summary.total_allocated_bytes > 0);
    let entry = &inspection.entries[0];
    assert_eq!(entry.status, WorkspaceImageCacheInspectionStatus::Reusable);
    assert_eq!(entry.storage_count, 2);
    assert_eq!(entry.artifact_count, 1);
    assert_eq!(entry.allocated_bytes, allocated_bytes(&current_metadata));
    assert_eq!(entry.logical_image_size_bytes, current_metadata.len());
}

#[tokio::test]
async fn inspect_reports_invalid_metadata_reason() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let key = cache.scoped_cache_key(TEST_PROFILE_NAME, "sess-1", "/workspace", 5);
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
                session_id: "other-session".into(),
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

    let inspection = cache.inspect().await.unwrap();

    assert_eq!(inspection.summary.invalid_entries, 1);
    let entry = &inspection.entries[0];
    assert_eq!(entry.status, WorkspaceImageCacheInspectionStatus::Invalid);
    assert_eq!(entry.reason.as_deref(), Some("cache key mismatch"));
}

#[tokio::test]
async fn inspect_rejects_symlink_current_image() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let image = b"image";
    let key = cache.scoped_cache_key(
        TEST_PROFILE_NAME,
        "sess-1",
        "/workspace",
        image.len() as u64,
    );
    fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
        .await
        .unwrap();
    let target = dir.path().join("target.ext4");
    fs::write(&target, image).await.unwrap();
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
                last_completed_at: "2026-05-01T00:00:00.000Z".into(),
                last_used_at: "2026-05-01T00:01:00.000Z".into(),
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

    let inspection = cache.inspect().await.unwrap();

    assert_eq!(inspection.summary.invalid_entries, 1);
    let entry = &inspection.entries[0];
    assert_eq!(entry.status, WorkspaceImageCacheInspectionStatus::Invalid);
    assert_eq!(entry.reason.as_deref(), Some("current image is not a file"));
}

#[tokio::test]
async fn inspect_reports_current_directory_as_invalid() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let session_id = "sess-1";
    let working_dir = "/workspace";
    let probe = dir.path().join("current-probe");
    tokio::fs::create_dir_all(&probe).await.unwrap();
    let image_size_bytes = fs::metadata(&probe).await.unwrap().len();
    tokio::fs::remove_dir_all(&probe).await.unwrap();
    let key = cache.scoped_cache_key(TEST_PROFILE_NAME, session_id, working_dir, image_size_bytes);
    let current = paths.session_workspace_cache_current_image(&key);
    fs::create_dir_all(&current).await.unwrap();
    fs::write(current.join("nested"), vec![1_u8; 4096])
        .await
        .unwrap();
    let current_metadata = fs::symlink_metadata(&current).await.unwrap();
    cache
        .write_metadata(
            &key,
            run_id,
            WorkspaceCacheMetadata {
                format_version: CACHE_FORMAT_VERSION,
                key_version: CACHE_KEY_VERSION,
                cache_scope: String::new(),
                profile_name: TEST_PROFILE_NAME.into(),
                session_id: session_id.into(),
                working_dir: working_dir.into(),
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

    let inspection = cache.inspect().await.unwrap();

    assert_eq!(inspection.summary.invalid_entries, 1);
    let entry = &inspection.entries[0];
    assert_eq!(entry.status, WorkspaceImageCacheInspectionStatus::Invalid);
    assert_eq!(entry.reason.as_deref(), Some("current image is not a file"));
    assert!(
        entry.allocated_bytes > allocated_bytes(&current_metadata),
        "inspection should count nested bytes for directory-shaped current images",
    );
}

#[tokio::test]
async fn inspect_reports_stale_entry_without_current_image() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let key = write_current_cache_entry(
        &cache,
        RunId::new_v4(),
        "sess-1",
        "/workspace",
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    fs::remove_file(paths.session_workspace_cache_current_image(&key))
        .await
        .unwrap();

    let inspection = cache.inspect().await.unwrap();

    assert_eq!(inspection.summary.stale_entries, 1);
    let entry = &inspection.entries[0];
    assert_eq!(entry.status, WorkspaceImageCacheInspectionStatus::Stale);
    assert_eq!(entry.reason.as_deref(), Some("missing current image"));
    assert_eq!(entry.profile_name.as_deref(), Some(TEST_PROFILE_NAME));
}

#[tokio::test]
async fn inspect_reports_temporary_only_entry() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let key = session_workspace_cache_key("sess-1", "/workspace");
    let tmp = paths.session_workspace_cache_tmp_image(&key, RunId::new_v4());
    fs::create_dir_all(tmp.parent().unwrap()).await.unwrap();
    fs::write(&tmp, b"partial image").await.unwrap();
    let tmp_metadata = fs::metadata(&tmp).await.unwrap();

    let inspection = cache.inspect().await.unwrap();

    assert_eq!(inspection.summary.temporary_entries, 1);
    assert_eq!(inspection.summary.temporary_paths, 1);
    assert_eq!(
        inspection.summary.temporary_allocated_bytes,
        allocated_bytes(&tmp_metadata)
    );
    let entry = &inspection.entries[0];
    assert_eq!(
        entry.status,
        WorkspaceImageCacheInspectionStatus::TemporaryOnly
    );
    assert_eq!(entry.temporary_path_count, 1);
}

#[tokio::test]
async fn inspect_reports_temporary_only_directory() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let key = session_workspace_cache_key("sess-1", "/workspace");
    let tmp = paths.session_workspace_cache_tmp_image(&key, RunId::new_v4());
    fs::create_dir_all(&tmp).await.unwrap();
    fs::write(tmp.join("partial-image"), vec![1_u8; 4096])
        .await
        .unwrap();

    let inspection = cache.inspect().await.unwrap();

    assert_eq!(inspection.summary.temporary_entries, 1);
    assert_eq!(inspection.summary.temporary_paths, 1);
    assert!(inspection.summary.temporary_allocated_bytes > 0);
    let entry = &inspection.entries[0];
    assert_eq!(
        entry.status,
        WorkspaceImageCacheInspectionStatus::TemporaryOnly
    );
    assert_eq!(
        entry.reason.as_deref(),
        Some("missing current image; temporary paths present")
    );
    assert_eq!(entry.temporary_path_count, 1);
    assert!(entry.temporary_allocated_bytes > 0);
}

#[tokio::test]
async fn inspect_reports_locked_entry_without_blocking() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let key = session_workspace_cache_key("sess-1", "/workspace");
    fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
        .await
        .unwrap();
    fs::write(
        paths.session_workspace_cache_tmp_image(&key, RunId::new_v4()),
        b"partial image",
    )
    .await
    .unwrap();
    let _lock = crate::lock::acquire(cache.entry_lock_path(&key))
        .await
        .unwrap();

    let inspection = cache.inspect().await.unwrap();

    assert_eq!(inspection.summary.locked_entries, 1);
    assert_eq!(inspection.summary.temporary_paths, 0);
    let entry = &inspection.entries[0];
    assert_eq!(entry.status, WorkspaceImageCacheInspectionStatus::Locked);
    assert_eq!(entry.reason.as_deref(), Some("entry lock is held"));
    assert_eq!(entry.temporary_path_count, 0);
}

#[tokio::test]
async fn inspect_propagates_lock_path_errors() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = SessionWorkspaceCache::new(paths.clone());
    let key = session_workspace_cache_key("sess-1", "/workspace");
    fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
        .await
        .unwrap();
    fs::write(paths.base_dir().join("locks"), b"not a directory")
        .await
        .unwrap();

    let err = cache.inspect().await.unwrap_err();

    assert!(
        err.to_string().contains("create lock dir"),
        "unexpected error: {err}"
    );
}

#[tokio::test]
async fn inspect_entry_skips_directory_removed_after_scan() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = SessionWorkspaceCache::new(paths.clone());
    let key = session_workspace_cache_key("sess-1", "/workspace");
    let entry_dir = paths.session_workspace_cache_entry_dir(&key);
    fs::create_dir_all(&entry_dir).await.unwrap();
    fs::remove_dir_all(&entry_dir).await.unwrap();

    let entry = cache.inspect_entry(key, entry_dir).await.unwrap();

    assert!(entry.is_none());
}

#[tokio::test]
async fn inspect_entry_skips_symlink_replacement_after_scan() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = SessionWorkspaceCache::new(paths.clone());
    let key = session_workspace_cache_key("sess-1", "/workspace");
    let entry_dir = paths.session_workspace_cache_entry_dir(&key);
    fs::create_dir_all(entry_dir.parent().unwrap())
        .await
        .unwrap();
    let target = dir.path().join("outside-cache-entry");
    fs::create_dir_all(&target).await.unwrap();
    std::os::unix::fs::symlink(&target, &entry_dir).unwrap();

    let entry = cache.inspect_entry(key, entry_dir).await.unwrap();

    assert!(entry.is_none());
}

#[tokio::test]
async fn inspect_reports_non_file_metadata_as_invalid_entry() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = SessionWorkspaceCache::new(paths.clone());
    let key = session_workspace_cache_key("sess-1", "/workspace");
    fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
        .await
        .unwrap();
    fs::write(paths.session_workspace_cache_current_image(&key), b"image")
        .await
        .unwrap();
    fs::create_dir(paths.session_workspace_cache_metadata(&key))
        .await
        .unwrap();

    let inspection = cache.inspect().await.unwrap();

    assert_eq!(inspection.summary.invalid_entries, 1);
    let entry = &inspection.entries[0];
    assert_eq!(entry.status, WorkspaceImageCacheInspectionStatus::Invalid);
    assert_eq!(entry.reason.as_deref(), Some("missing or invalid metadata"));
}

#[tokio::test]
async fn inspect_rejects_metadata_symlink_without_following_it() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = SessionWorkspaceCache::new(paths.clone());
    let key = session_workspace_cache_key("sess-1", "/workspace");
    fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
        .await
        .unwrap();
    fs::write(paths.session_workspace_cache_current_image(&key), b"image")
        .await
        .unwrap();
    let outside = dir.path().join("outside-metadata.json");
    fs::write(&outside, b"{\"unexpected\":true}").await.unwrap();
    std::os::unix::fs::symlink(&outside, paths.session_workspace_cache_metadata(&key)).unwrap();

    let inspection = cache.inspect().await.unwrap();

    assert_eq!(inspection.summary.invalid_entries, 1);
    let entry = &inspection.entries[0];
    assert_eq!(entry.status, WorkspaceImageCacheInspectionStatus::Invalid);
    assert_eq!(entry.reason.as_deref(), Some("missing or invalid metadata"));
}

#[tokio::test]
async fn inspect_rejects_fifo_metadata_without_blocking() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = SessionWorkspaceCache::new(paths.clone());
    let key = session_workspace_cache_key("sess-1", "/workspace");
    fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
        .await
        .unwrap();
    fs::write(paths.session_workspace_cache_current_image(&key), b"image")
        .await
        .unwrap();
    make_fifo(&paths.session_workspace_cache_metadata(&key));

    let inspection = cache.inspect().await.unwrap();

    assert_eq!(inspection.summary.invalid_entries, 1);
    let entry = &inspection.entries[0];
    assert_eq!(entry.status, WorkspaceImageCacheInspectionStatus::Invalid);
    assert_eq!(entry.reason.as_deref(), Some("missing or invalid metadata"));
}

#[tokio::test]
async fn inspect_rejects_oversized_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = SessionWorkspaceCache::new(paths.clone());
    let key = session_workspace_cache_key("sess-1", "/workspace");
    fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
        .await
        .unwrap();
    fs::write(paths.session_workspace_cache_current_image(&key), b"image")
        .await
        .unwrap();
    fs::write(
        paths.session_workspace_cache_metadata(&key),
        vec![b' '; crate::state_file::WORKSPACE_METADATA_MAX_BYTES as usize + 1],
    )
    .await
    .unwrap();

    let inspection = cache.inspect().await.unwrap();

    assert_eq!(inspection.summary.invalid_entries, 1);
    let entry = &inspection.entries[0];
    assert_eq!(entry.status, WorkspaceImageCacheInspectionStatus::Invalid);
    assert_eq!(entry.reason.as_deref(), Some("missing or invalid metadata"));
}

#[tokio::test]
async fn prepare_removes_symlink_cache_entry_without_following_it() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
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
            run_id,
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: Some(session_id),
            working_dir: "/workspace",
            image_size_bytes: 5,
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

#[test]
fn cache_key_separates_profile_and_image_size() {
    let base =
        scoped_session_workspace_cache_key("vm0/test", "vm0/default", "sess-1", "/workspace", 5);

    assert_ne!(
        base,
        scoped_session_workspace_cache_key("vm0/test", "vm0/browser", "sess-1", "/workspace", 5,)
    );
    assert_ne!(
        base,
        scoped_session_workspace_cache_key("vm0/test", "vm0/default", "sess-1", "/workspace", 6,)
    );
}

#[test]
fn workspace_scoped_fingerprints_do_not_match_prefix_traps() {
    let fingerprints = StorageFingerprints {
        storages: HashMap::from([
            ("/workspace".into(), StorageFingerprint::new("repo", "v1")),
            (
                "/workspace/sub".into(),
                StorageFingerprint::new("sub", "v1"),
            ),
            (
                "/workspace//sub2".into(),
                StorageFingerprint::new("sub2", "v1"),
            ),
            ("/workspace2".into(), StorageFingerprint::new("trap", "v1")),
            (
                "/workspace/../outside".into(),
                StorageFingerprint::new("escape", "v1"),
            ),
            ("/tmp/cache".into(), StorageFingerprint::new("tmp", "v1")),
        ]),
        artifacts: HashMap::from([
            (
                "/workspace/art".into(),
                StorageFingerprint::new("art", "v1"),
            ),
            (
                "/home/user/.codex".into(),
                StorageFingerprint::new("codex", "v1"),
            ),
        ]),
    };

    let filtered = filter_storage_fingerprints_for_working_dir(&fingerprints, "/workspace");

    assert!(filtered.storages.contains_key("/workspace"));
    assert!(filtered.storages.contains_key("/workspace/sub"));
    assert!(filtered.storages.contains_key("/workspace//sub2"));
    assert!(!filtered.storages.contains_key("/workspace2"));
    assert!(!filtered.storages.contains_key("/workspace/../outside"));
    assert!(!filtered.storages.contains_key("/tmp/cache"));
    assert!(filtered.artifacts.contains_key("/workspace/art"));
    assert!(!filtered.artifacts.contains_key("/home/user/.codex"));

    let trailing_slash_filtered =
        filter_storage_fingerprints_for_working_dir(&fingerprints, "/workspace/");
    assert!(trailing_slash_filtered.storages.contains_key("/workspace"));
    assert!(
        trailing_slash_filtered
            .storages
            .contains_key("/workspace/sub")
    );
    assert!(!trailing_slash_filtered.storages.contains_key("/workspace2"));
}

#[test]
fn cap_workspace_held_session_states_dedupes_and_keeps_newest() {
    let mut states: Vec<HeldSessionState> = (0..=MAX_HELD_SESSION_STATES)
        .map(|index| HeldSessionState {
            session_id: format!("sess-{index:04}"),
            last_completed_at: timestamp_for_index(index),
        })
        .collect();
    states.push(HeldSessionState {
        session_id: "sess-0001".into(),
        last_completed_at: timestamp_for_index(MAX_HELD_SESSION_STATES + 1),
    });

    let capped = cap_workspace_held_session_states(states);

    assert_eq!(capped.len(), MAX_HELD_SESSION_STATES);
    assert!(
        !capped.iter().any(|state| state.session_id == "sess-0000"),
        "oldest advertised cache state should be dropped"
    );
    assert!(capped.iter().any(|state| {
        state.session_id == "sess-0001"
            && state.last_completed_at == timestamp_for_index(MAX_HELD_SESSION_STATES + 1)
    }));
    assert!(
        capped
            .iter()
            .any(|state| state.session_id == format!("sess-{MAX_HELD_SESSION_STATES:04}"))
    );
}

#[test]
fn safe_guest_working_dir_rejects_root_relative_and_parent() {
    assert!(is_safe_guest_working_dir("/home/user/workspace"));
    assert_eq!(
        normalize_safe_guest_working_dir("/home//user/workspace/").as_deref(),
        Some("/home/user/workspace"),
    );
    assert!(!is_safe_guest_working_dir("/"));
    assert!(!is_safe_guest_working_dir("//"));
    assert!(!is_safe_guest_working_dir("///"));
    assert!(!is_safe_guest_working_dir("/."));
    assert!(!is_safe_guest_working_dir("/./"));
    assert!(!is_safe_guest_working_dir("/workspace/."));
    assert!(!is_safe_guest_working_dir("workspace"));
    assert!(!is_safe_guest_working_dir("/home/../workspace"));
    assert!(!is_safe_guest_working_dir("/home/user/work\0space"));
}

#[tokio::test]
async fn invalid_working_dir_allocates_only_required_workspace_drive() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths);

    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id: RunId::new_v4(),
            sandbox_id: sandbox::SandboxId::new_v4(),
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: Some("sess-1"),
            working_dir: "/",
            image_size_bytes: 1024,
            workspace_drive_required: false,
        })
        .await;

    assert_eq!(
        lease.result(),
        WorkspaceCacheCheckoutResult::InvalidWorkingDir
    );
    assert!(lease.workspace_drive_config().is_none());

    let no_session_lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id: RunId::new_v4(),
            sandbox_id: sandbox::SandboxId::new_v4(),
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: None,
            working_dir: "/",
            image_size_bytes: 1024,
            workspace_drive_required: false,
        })
        .await;

    assert_eq!(
        no_session_lease.result(),
        WorkspaceCacheCheckoutResult::InvalidWorkingDir
    );
    assert!(no_session_lease.workspace_drive_config().is_none());

    let snapshot_restore_lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id: RunId::new_v4(),
            sandbox_id: sandbox::SandboxId::new_v4(),
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: Some("sess-1"),
            working_dir: "/",
            image_size_bytes: 1024,
            workspace_drive_required: true,
        })
        .await;

    assert_eq!(
        snapshot_restore_lease.result(),
        WorkspaceCacheCheckoutResult::InvalidWorkingDir
    );
    assert!(snapshot_restore_lease.workspace_drive_config().is_some());
    assert!(
        !snapshot_restore_lease
            .promote(
                RunId::new_v4(),
                Some("sess-1"),
                WorkspaceCacheTerminalStatus::Success,
                local_timestamp(),
                &StorageFingerprints::default(),
            )
            .await
            .unwrap(),
        "unsafe working dirs may require an attached drive for snapshot restore but must not be cached",
    );
}

#[tokio::test]
async fn prepare_normalizes_working_dir_for_cache_identity() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();

    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id,
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: Some("sess-1"),
            working_dir: "/workspace//repo/",
            image_size_bytes: 1024,
            workspace_drive_required: false,
        })
        .await;

    assert_eq!(lease.working_dir(), "/workspace/repo");
    let expected_key = cache.scoped_cache_key(TEST_PROFILE_NAME, "sess-1", "/workspace/repo", 1024);
    assert_eq!(lease.cache_key.as_deref(), Some(expected_key.as_str()));
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
            run_id,
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: Some("sess-1"),
            working_dir: "/workspace",
            image_size_bytes: 5,
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
    drop(lease);

    let checkout = cache_b
        .prepare(WorkspaceImagePrepareRequest {
            run_id: RunId::new_v4(),
            sandbox_id: sandbox::SandboxId::new_v4(),
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: Some("sess-1"),
            working_dir: "/workspace",
            image_size_bytes: 5,
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
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
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
            run_id: RunId::new_v4(),
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: Some("sess-move-hit"),
            working_dir: "/workspace",
            image_size_bytes: image_size,
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
async fn metadata_missing_current_present_is_not_a_cache_hit() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let key = cache.scoped_cache_key(TEST_PROFILE_NAME, "sess-no-metadata", "/workspace", 5);
    fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
        .await
        .unwrap();
    fs::write(paths.session_workspace_cache_current_image(&key), b"image")
        .await
        .unwrap();

    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id: RunId::new_v4(),
            sandbox_id: sandbox::SandboxId::new_v4(),
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: Some("sess-no-metadata"),
            working_dir: "/workspace",
            image_size_bytes: 5,
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
async fn consumed_cache_hit_promotion_copies_active_image_back_to_cache() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
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
            run_id,
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: Some("sess-move-promote"),
            working_dir: "/workspace",
            image_size_bytes: image_size,
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
async fn consumed_cache_hit_invalidation_tolerates_missing_current() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
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
            run_id,
            sandbox_id: sandbox::SandboxId::new_v4(),
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: Some("sess-move-invalidate"),
            working_dir: "/workspace",
            image_size_bytes: image_size,
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
            run_id: RunId::new_v4(),
            sandbox_id: sandbox::SandboxId::new_v4(),
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: Some("sess-1"),
            working_dir: "/workspace",
            image_size_bytes: 5,
            workspace_drive_required: false,
        })
        .await;
    assert_eq!(lease_a.result(), WorkspaceCacheCheckoutResult::Miss);

    let blocked_checkout = cache_b
        .prepare(WorkspaceImagePrepareRequest {
            run_id: RunId::new_v4(),
            sandbox_id: sandbox::SandboxId::new_v4(),
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: Some("sess-1"),
            working_dir: "/workspace",
            image_size_bytes: 5,
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
            run_id: RunId::new_v4(),
            sandbox_id: sandbox::SandboxId::new_v4(),
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: Some("sess-1"),
            working_dir: "/workspace",
            image_size_bytes: 5,
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
            run_id,
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: Some("sess-1"),
            working_dir: "/workspace",
            image_size_bytes: 5,
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
    drop(lease);

    let checkout = cache_b
        .prepare(WorkspaceImagePrepareRequest {
            run_id: RunId::new_v4(),
            sandbox_id: sandbox::SandboxId::new_v4(),
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: Some("sess-1"),
            working_dir: "/workspace",
            image_size_bytes: 5,
            workspace_drive_required: false,
        })
        .await;

    assert_eq!(checkout.result(), WorkspaceCacheCheckoutResult::Miss);
    assert!(checkout.source_image.is_none());
    assert!(
        cache_b.held_session_states().await.is_empty(),
        "a runner must not advertise workspace cache entries from another group"
    );
}

#[tokio::test]
async fn global_gc_preserves_other_group_cache_entries_when_under_budget() {
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
    let cache_b = SessionWorkspaceCache::shared(runner_b, &home, "group-b");
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();

    let lease = cache_a
        .prepare(WorkspaceImagePrepareRequest {
            run_id,
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: Some("sess-1"),
            working_dir: "/workspace",
            image_size_bytes: 5,
            workspace_drive_required: false,
        })
        .await;
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
    drop(lease);

    cache_b.gc(false).await.unwrap();

    assert_eq!(cache_a.held_session_states().await.len(), 1);
}

#[tokio::test]
async fn maintenance_gc_preserves_valid_group_scoped_entry() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    tokio::fs::create_dir_all(home.workspace_image_cache_dir().parent().unwrap())
        .await
        .unwrap();
    let runner = RunnerPaths::new(dir.path().join("runner"));
    let maintenance_runner = RunnerPaths::new(dir.path().join("maintenance-runner"));
    tokio::fs::create_dir_all(runner.base_dir()).await.unwrap();
    tokio::fs::create_dir_all(maintenance_runner.base_dir())
        .await
        .unwrap();
    let cache = SessionWorkspaceCache::shared(runner.clone(), &home, "group-a");
    let maintenance_cache = SessionWorkspaceCache::shared(maintenance_runner, &home, "");
    let key = promote_current_cache_entry(
        &cache,
        &runner,
        "sess-1",
        b"image",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let current = cache.session_workspace_cache_current_image(&key);
    let metadata = cache.session_workspace_cache_metadata(&key);

    maintenance_cache.gc(false).await.unwrap();

    assert!(current.exists());
    assert!(metadata.exists());
}

#[tokio::test]
async fn global_gc_candidates_include_other_group_cache_entries() {
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

    let group_a_key = promote_current_cache_entry(
        &cache_a,
        &runner_a,
        "sess-a",
        b"image-a",
        "2026-05-01T00:00:00.000Z",
    )
    .await;

    assert!(
        cache_a.gc_candidate(group_a_key.clone()).await.is_some(),
        "own group entries should remain eligible for GC"
    );
    assert!(
        cache_b.gc_candidate(group_a_key.clone()).await.is_some(),
        "GC budget candidates should include valid entries from other groups"
    );

    let group_b_key = promote_current_cache_entry(
        &cache_b,
        &runner_b,
        "sess-b",
        b"image-b",
        "2026-05-01T00:01:00.000Z",
    )
    .await;

    let candidates = cache_b.gc_candidates().await.unwrap();
    let candidate_keys: Vec<_> = candidates
        .into_iter()
        .map(|candidate| candidate.cache_key)
        .collect();
    assert_eq!(candidate_keys.len(), 2);
    assert!(candidate_keys.contains(&group_a_key));
    assert!(candidate_keys.contains(&group_b_key));
}

#[tokio::test]
async fn global_gc_evicts_old_entry_from_other_group_under_free_space_pressure() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    let runner_a = RunnerPaths::new(dir.path().join("runner-a"));
    let runner_b = RunnerPaths::new(dir.path().join("runner-b"));
    tokio::fs::create_dir_all(runner_a.base_dir())
        .await
        .unwrap();
    tokio::fs::create_dir_all(runner_b.base_dir())
        .await
        .unwrap();

    let budget = CacheBudget::from_fs_stats(FsStats {
        total_bytes: TEST_FS_TOTAL_BYTES,
        available_bytes: TEST_FS_AVAILABLE_BYTES,
    });
    let pressure_stats = FsStats {
        total_bytes: TEST_FS_TOTAL_BYTES,
        available_bytes: budget.min_free_bytes.saturating_sub(1),
    };
    let cache_dir = home.workspace_image_cache_dir();
    let lock_dir = home.locks_dir();
    let cache_a = SessionWorkspaceCache::with_cache_dirs_and_fs_stats(
        runner_a.clone(),
        cache_dir.clone(),
        lock_dir.clone(),
        "group-a",
        pressure_stats,
    );
    let cache_b = SessionWorkspaceCache::with_cache_dirs_and_fs_stats(
        runner_b.clone(),
        cache_dir,
        lock_dir,
        "group-b",
        pressure_stats,
    );
    let run_id = RunId::new_v4();
    let old_key = write_current_cache_entry(
        &cache_a,
        run_id,
        "sess-a",
        "/workspace",
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let new_key = write_current_cache_entry(
        &cache_b,
        run_id,
        "sess-b",
        "/workspace",
        "2026-05-01T00:01:00.000Z",
        "2026-05-01T00:01:00.000Z",
    )
    .await;

    let freed = cache_b.gc(false).await.unwrap();

    assert!(freed > 0);
    assert!(
        !cache_a
            .session_workspace_cache_current_image(&old_key)
            .exists(),
        "oldest global candidate can be evicted even when it belongs to another group"
    );
    assert!(
        cache_b
            .session_workspace_cache_current_image(&new_key)
            .exists(),
        "newer candidate from the current group should be retained once pressure is relieved"
    );
    assert!(cache_a.held_session_states().await.is_empty());
    assert_eq!(cache_b.held_session_states().await.len(), 1);
}

#[tokio::test]
async fn global_gc_prunes_oldest_entries_above_limit_across_runner_groups() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    let runner_a = RunnerPaths::new(dir.path().join("runner-a"));
    let runner_b = RunnerPaths::new(dir.path().join("runner-b"));
    tokio::fs::create_dir_all(runner_a.base_dir())
        .await
        .unwrap();
    tokio::fs::create_dir_all(runner_b.base_dir())
        .await
        .unwrap();
    let cache_dir = home.workspace_image_cache_dir();
    let lock_dir = home.locks_dir();
    let fs_stats = FsStats {
        total_bytes: TEST_FS_TOTAL_BYTES,
        available_bytes: TEST_FS_AVAILABLE_BYTES,
    };
    let cache_a = SessionWorkspaceCache::with_cache_dirs_and_fs_stats(
        runner_a.clone(),
        cache_dir.clone(),
        lock_dir.clone(),
        "group-a",
        fs_stats,
    );
    let cache_b = SessionWorkspaceCache::with_cache_dirs_and_fs_stats(
        runner_b.clone(),
        cache_dir,
        lock_dir,
        "group-b",
        fs_stats,
    );
    let run_id = RunId::new_v4();
    let oldest_key = write_current_cache_entry(
        &cache_a,
        run_id,
        "sess-a-0000",
        "/workspace",
        &timestamp_for_index(0),
        &timestamp_for_index(0),
    )
    .await;
    let mut newest_key = String::new();
    for index in 1..=MAX_HELD_SESSION_STATES {
        let session_id = format!("sess-b-{index:04}");
        let timestamp = timestamp_for_index(index);
        let key = write_current_cache_entry(
            &cache_b,
            run_id,
            &session_id,
            "/workspace",
            &timestamp,
            &timestamp,
        )
        .await;
        if index == MAX_HELD_SESSION_STATES {
            newest_key = key;
        }
    }

    let freed = cache_b.gc(false).await.unwrap();

    assert!(freed > 0);
    assert!(
        !cache_a
            .session_workspace_cache_current_image(&oldest_key)
            .exists(),
        "oldest global candidate should be removed when the shared cache exceeds the entry cap"
    );
    assert!(
        cache_b
            .session_workspace_cache_current_image(&newest_key)
            .exists(),
        "newest candidate should be retained"
    );
    assert_eq!(
        cache_b.gc_candidates().await.unwrap().len(),
        MAX_HELD_SESSION_STATES
    );
    assert!(cache_a.held_session_states().await.is_empty());
    assert_eq!(
        cache_b.held_session_states().await.len(),
        MAX_HELD_SESSION_STATES
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
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
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
            run_id,
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: Some("sess-1"),
            working_dir: "/workspace",
            image_size_bytes: image_size,
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
    drop(lease);
    assert_eq!(cache.held_session_states().await.len(), 1);
}

#[tokio::test]
async fn held_session_states_rejects_metadata_under_wrong_cache_key() {
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
                session_id: "sess-other".into(),
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

    assert!(
        cache.held_session_states().await.is_empty(),
        "metadata must not be advertised from a cache key derived from another session"
    );
}

#[tokio::test]
async fn held_session_states_rejects_unsafe_working_dir_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().to_path_buf());
    let cache = SessionWorkspaceCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let key = session_workspace_cache_key("sess-1", "/");
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
                session_id: "sess-1".into(),
                working_dir: "/".into(),
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

    assert!(
        cache.held_session_states().await.is_empty(),
        "unsafe working dirs must not be advertised for affinity",
    );
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

#[test]
fn copy_headroom_requires_min_free_after_copy() {
    let budget = CacheBudget {
        max_cache_bytes: 100,
        target_after_gc_bytes: 75,
        min_free_bytes: 50,
        max_entry_bytes: 100,
    };

    assert!(has_copy_headroom(
        FsStats {
            total_bytes: 200,
            available_bytes: 75,
        },
        budget,
        25,
    ));
    assert!(!has_copy_headroom(
        FsStats {
            total_bytes: 200,
            available_bytes: 74,
        },
        budget,
        25,
    ));
}

#[test]
fn gc_budget_satisfied_counts_only_candidate_deletes_after_pre_cleanup() {
    let budget = CacheBudget {
        max_cache_bytes: 100,
        target_after_gc_bytes: 75,
        min_free_bytes: 50,
        max_entry_bytes: 100,
    };
    let stats_after_pre_cleanup = FsStats {
        total_bytes: 200,
        available_bytes: 40,
    };

    assert!(!gc_budget_satisfied(
        true,
        75,
        MAX_HELD_SESSION_STATES,
        stats_after_pre_cleanup,
        budget,
        0,
    ));
    assert!(gc_budget_satisfied(
        true,
        75,
        MAX_HELD_SESSION_STATES,
        stats_after_pre_cleanup,
        budget,
        10,
    ));
}

#[test]
fn gc_budget_satisfied_enforces_entry_cap_even_without_disk_pressure() {
    let budget = CacheBudget {
        max_cache_bytes: 100,
        target_after_gc_bytes: 75,
        min_free_bytes: 50,
        max_entry_bytes: 100,
    };

    assert!(!gc_budget_satisfied(
        false,
        50,
        MAX_HELD_SESSION_STATES + 1,
        FsStats {
            total_bytes: 200,
            available_bytes: 100,
        },
        budget,
        0,
    ));
}

#[tokio::test]
async fn cache_hit_checkout_does_not_require_copy_headroom() {
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
                session_id: "sess-1".into(),
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
            run_id,
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: Some("sess-1"),
            working_dir: "/workspace",
            image_size_bytes: current_metadata.len(),
            workspace_drive_required: false,
        })
        .await;

    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Hit);
    assert!(lease.can_attempt_promotion(Some("sess-1")));
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
    tokio::fs::rename(&current, paths.active_workspace_image(&sandbox_id))
        .await
        .unwrap();

    assert!(
        !lease
            .promote(
                run_id,
                None,
                WorkspaceCacheTerminalStatus::Success,
                "2026-05-02T00:00:00.000Z".into(),
                &StorageFingerprints::default(),
            )
            .await
            .unwrap(),
        "checkout does not need copy headroom, but publishing an independent cache copy still does"
    );
    assert!(
        !tokio::fs::try_exists(&current).await.unwrap(),
        "failed copy promotion must not publish reusable metadata for the consumed cache hit"
    );
}

#[tokio::test]
async fn lock_busy_checkout_cannot_promote_without_entry_lock() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let cache_key = cache.scoped_cache_key(TEST_PROFILE_NAME, "sess-1", "/workspace", 1024);
    let _held_lock = crate::lock::acquire(cache.entry_lock_path(&cache_key))
        .await
        .unwrap();

    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id,
            sandbox_id: sandbox::SandboxId::new_v4(),
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: Some("sess-1"),
            working_dir: "/workspace",
            image_size_bytes: 1024,
            workspace_drive_required: false,
        })
        .await;

    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::LockBusy);
    assert!(!lease.can_attempt_promotion(Some("sess-1")));
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
async fn active_lease_hides_cached_session_until_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
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
                session_id: "sess-1".into(),
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

    assert_eq!(cache.held_session_states().await.len(), 1);

    let lease = cache
        .lease_active(WorkspaceImageActiveLeaseRequest {
            run_id,
            sandbox_id: sandbox::SandboxId::new_v4(),
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: Some("sess-1"),
            working_dir: "/workspace",
            image_size_bytes: 5,
            workspace_drive_available: true,
        })
        .await;

    assert!(cache.held_session_states().await.is_empty());
    drop(lease);
    assert_eq!(cache.held_session_states().await.len(), 1);
}

#[tokio::test]
async fn promotion_context_keeps_entry_locked_until_reused_active_lease_drops() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let session_id = "sess-locked-context";
    let image_size_bytes = 16 * 1024 * 1024;

    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id,
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: Some(session_id),
            working_dir: "/workspace",
            image_size_bytes,
            workspace_drive_required: false,
        })
        .await;
    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Miss);

    let promotion = lease
        .into_promotion_context(WorkspaceImagePromotionRequest {
            run_id,
            sandbox_id,
            cli_agent_session_id_override: Some(session_id),
            terminal_status: WorkspaceCacheTerminalStatus::Success,
            completed_at: local_timestamp(),
            storage_fingerprints: StorageFingerprints::default(),
            promotable: true,
        })
        .unwrap();

    let blocked_by_context = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id: RunId::new_v4(),
            sandbox_id: sandbox::SandboxId::new_v4(),
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: Some(session_id),
            working_dir: "/workspace",
            image_size_bytes,
            workspace_drive_required: false,
        })
        .await;
    assert_eq!(
        blocked_by_context.result(),
        WorkspaceCacheCheckoutResult::LockBusy
    );

    let active_lease = promotion.into_active_lease(WorkspaceImageActiveLeaseRequest {
        run_id: RunId::new_v4(),
        sandbox_id,
        profile_name: TEST_PROFILE_NAME,
        cli_agent_session_id: Some(session_id),
        working_dir: "/workspace",
        image_size_bytes,
        workspace_drive_available: true,
    });

    let blocked_by_active_lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id: RunId::new_v4(),
            sandbox_id: sandbox::SandboxId::new_v4(),
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: Some(session_id),
            working_dir: "/workspace",
            image_size_bytes,
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
            run_id: RunId::new_v4(),
            sandbox_id: sandbox::SandboxId::new_v4(),
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: Some(session_id),
            working_dir: "/workspace",
            image_size_bytes,
            workspace_drive_required: false,
        })
        .await;
    assert_eq!(after_drop.result(), WorkspaceCacheCheckoutResult::Miss);
}

#[tokio::test]
async fn gc_candidate_detects_replaced_image_with_same_timestamp() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let cache_key = session_workspace_cache_key("sess-1", "/workspace");
    let entry_dir = paths.session_workspace_cache_entry_dir(&cache_key);
    tokio::fs::create_dir_all(&entry_dir).await.unwrap();
    let current = paths.session_workspace_cache_current_image(&cache_key);
    tokio::fs::write(&current, b"old image").await.unwrap();
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
                session_id: "sess-1".into(),
                working_dir: "/workspace".into(),
                last_completed_at: "2026-05-01T00:00:00.000Z".into(),
                last_used_at: "2026-05-01T00:00:00.000Z".into(),
                last_terminal_status: WorkspaceCacheTerminalStatus::Success,
                workspace_trust: WorkspaceTrust::Clean,
                logical_image_size_bytes: 9,
                allocated_bytes: 9,
                current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
                drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
                storage_fingerprints: StorageFingerprints::default(),
                state: WorkspaceCacheState::Current,
            },
        )
        .await
        .unwrap();

    let old_candidate = cache.gc_candidate(cache_key.clone()).await.unwrap();
    let replacement = entry_dir.join("current.ext4.tmp");
    tokio::fs::write(&replacement, b"new image").await.unwrap();
    tokio::fs::rename(&replacement, &current).await.unwrap();
    let refreshed_candidate = cache.gc_candidate(cache_key).await.unwrap();

    assert_eq!(refreshed_candidate.last_used_at, old_candidate.last_used_at);
    assert!(
        !refreshed_candidate.same_current_image(&old_candidate),
        "GC must notice current.ext4 was replaced even when metadata timestamp is unchanged",
    );
}

#[tokio::test]
async fn gc_candidate_includes_current_image_without_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let cache_key = session_workspace_cache_key("sess-1", "/workspace");
    tokio::fs::create_dir_all(paths.session_workspace_cache_entry_dir(&cache_key))
        .await
        .unwrap();
    let current = paths.session_workspace_cache_current_image(&cache_key);
    tokio::fs::write(&current, b"orphan image").await.unwrap();

    let candidate = cache.gc_candidate(cache_key.clone()).await.unwrap();

    assert_eq!(candidate.cache_key, cache_key);
    assert!(current.exists());
    assert_eq!(candidate.last_used_at, "");
    assert!(candidate.allocated_bytes > 0);
}

#[tokio::test]
async fn gc_prunes_oldest_entries_above_held_session_limit() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let run_id = RunId::new_v4();

    let mut oldest_key = String::new();
    let mut newest_key = String::new();
    for index in 0..=MAX_HELD_SESSION_STATES {
        let session_id = format!("sess-{index:04}");
        let timestamp = timestamp_for_index(index);
        let key = write_current_cache_entry(
            &cache,
            run_id,
            &session_id,
            "/workspace",
            &timestamp,
            &timestamp,
        )
        .await;
        if index == 0 {
            oldest_key = key.clone();
        }
        if index == MAX_HELD_SESSION_STATES {
            newest_key = key;
        }
    }

    let freed = cache.gc(false).await.unwrap();

    assert!(freed > 0);
    assert!(
        !paths
            .session_workspace_cache_current_image(&oldest_key)
            .exists(),
        "oldest unlocked cache entry should be removed when the cache is over the advertised limit"
    );
    assert!(
        !paths
            .session_workspace_cache_entry_dir(&oldest_key)
            .exists(),
        "GC should remove the whole evicted entry so stale metadata directories do not slow heartbeat scans"
    );
    assert!(
        paths
            .session_workspace_cache_current_image(&newest_key)
            .exists(),
        "newest cache entry should be retained"
    );
    assert_eq!(
        cache.gc_candidates().await.unwrap().len(),
        MAX_HELD_SESSION_STATES
    );
    assert_eq!(
        cache.held_session_states().await.len(),
        MAX_HELD_SESSION_STATES
    );
}

#[tokio::test]
async fn gc_removes_stale_entry_without_current_image() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let key = write_current_cache_entry(
        &cache,
        run_id,
        "sess-1",
        "/workspace",
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    tokio::fs::remove_file(paths.session_workspace_cache_current_image(&key))
        .await
        .unwrap();

    let freed = cache.gc(false).await.unwrap();

    assert!(freed > 0);
    assert!(
        !paths.session_workspace_cache_entry_dir(&key).exists(),
        "stale metadata-only entries should not accumulate and slow heartbeat scans"
    );
}

#[tokio::test]
async fn gc_removes_unusable_current_entry_without_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let key = session_workspace_cache_key("sess-1", "/workspace");
    tokio::fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
        .await
        .unwrap();
    tokio::fs::write(
        paths.session_workspace_cache_current_image(&key),
        b"orphan image",
    )
    .await
    .unwrap();

    let freed = cache.gc(false).await.unwrap();

    assert!(freed > 0);
    assert!(
        !paths.session_workspace_cache_entry_dir(&key).exists(),
        "current images without metadata are not reusable and should not accumulate"
    );
}

#[tokio::test]
async fn gc_removes_unusable_current_symlink_loop_without_aborting() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let key = session_workspace_cache_key("sess-1", "/workspace");
    tokio::fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
        .await
        .unwrap();
    std::os::unix::fs::symlink(
        "current.ext4",
        paths.session_workspace_cache_current_image(&key),
    )
    .unwrap();

    let freed = cache.gc(false).await.unwrap();

    assert!(freed > 0);
    assert!(
        !paths.session_workspace_cache_entry_dir(&key).exists(),
        "symlink-loop current images are unusable and should not abort cache GC"
    );
}

#[tokio::test]
async fn gc_removes_unusable_current_entry_with_unreadable_metadata_path() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let key = session_workspace_cache_key("sess-1", "/workspace");
    tokio::fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
        .await
        .unwrap();
    tokio::fs::write(
        paths.session_workspace_cache_current_image(&key),
        b"orphan image",
    )
    .await
    .unwrap();
    tokio::fs::create_dir(paths.session_workspace_cache_metadata(&key))
        .await
        .unwrap();

    let freed = cache.gc(false).await.unwrap();

    assert!(freed > 0);
    assert!(
        !paths.session_workspace_cache_entry_dir(&key).exists(),
        "unreadable metadata paths make entries unusable and should not block cache GC"
    );
}

#[tokio::test]
async fn gc_dry_run_counts_temporary_only_entry_once() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let key = session_workspace_cache_key("sess-1", "/workspace");
    let entry_dir = paths.session_workspace_cache_entry_dir(&key);
    tokio::fs::create_dir_all(&entry_dir).await.unwrap();
    let tmp = paths.session_workspace_cache_tmp_image(&key, RunId::new_v4());
    tokio::fs::write(&tmp, vec![1_u8; 4096]).await.unwrap();
    let expected = directory_tree_allocated_bytes(&entry_dir).await;

    let freed = cache.gc(true).await.unwrap();

    assert_eq!(
        freed, expected,
        "dry-run should count temporary-only entries once, matching actual full-entry cleanup"
    );
    assert!(tmp.exists());
    assert!(entry_dir.exists());
}

#[tokio::test]
async fn gc_dry_run_counts_unusable_entry_with_temporary_path_once() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let key = session_workspace_cache_key("sess-1", "/workspace");
    let entry_dir = paths.session_workspace_cache_entry_dir(&key);
    tokio::fs::create_dir_all(&entry_dir).await.unwrap();
    let current = paths.session_workspace_cache_current_image(&key);
    tokio::fs::write(&current, b"orphan image").await.unwrap();
    let tmp = paths.session_workspace_cache_tmp_image(&key, RunId::new_v4());
    tokio::fs::write(&tmp, vec![1_u8; 4096]).await.unwrap();
    let expected = directory_tree_allocated_bytes(&entry_dir).await;

    let freed = cache.gc(true).await.unwrap();

    assert_eq!(
        freed, expected,
        "dry-run should not count temporary paths again after an unusable entry is already selected for cleanup"
    );
    assert!(current.exists());
    assert!(tmp.exists());
    assert!(entry_dir.exists());
}

#[tokio::test]
async fn gc_dry_run_uses_pre_cleanup_freed_bytes_for_disk_pressure() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let setup_cache = SessionWorkspaceCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let key = write_current_cache_entry(
        &setup_cache,
        run_id,
        "sess-1",
        "/workspace",
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let tmp = paths.session_workspace_cache_tmp_image(&key, run_id);
    tokio::fs::write(&tmp, vec![1_u8; 4096]).await.unwrap();
    let temporary_allocated = workspace_cache_path_allocated_bytes(&tmp).await;
    assert!(temporary_allocated > 0);

    let fs_total = TEST_FS_TOTAL_BYTES;
    let min_free = CacheBudget::from_fs_stats(FsStats {
        total_bytes: fs_total,
        available_bytes: fs_total,
    })
    .min_free_bytes;
    let cache = SessionWorkspaceCache::new_with_fs_stats(
        paths.clone(),
        FsStats {
            total_bytes: fs_total,
            available_bytes: min_free.saturating_sub(1),
        },
    );

    let freed = cache.gc(true).await.unwrap();

    assert_eq!(
        freed, temporary_allocated,
        "dry-run should account for pre-cleanup temporary bytes before deciding whether valid cache entries need budget GC"
    );
    assert!(tmp.exists());
    assert!(
        paths.session_workspace_cache_current_image(&key).exists(),
        "dry-run must not preview deleting a valid entry when temporary cleanup would relieve disk pressure"
    );
}

#[tokio::test]
async fn gc_removes_current_directory_even_when_metadata_matches() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let session_id = "sess-1";
    let working_dir = "/workspace";
    let probe = dir.path().join("current-probe");
    tokio::fs::create_dir_all(&probe).await.unwrap();
    let image_size_bytes = fs::metadata(&probe).await.unwrap().len();
    tokio::fs::remove_dir_all(&probe).await.unwrap();
    let key = cache.scoped_cache_key(TEST_PROFILE_NAME, session_id, working_dir, image_size_bytes);
    let current = paths.session_workspace_cache_current_image(&key);
    tokio::fs::create_dir_all(&current).await.unwrap();
    let current_metadata = fs::metadata(&current).await.unwrap();
    cache
        .write_metadata(
            &key,
            run_id,
            WorkspaceCacheMetadata {
                format_version: CACHE_FORMAT_VERSION,
                key_version: CACHE_KEY_VERSION,
                cache_scope: cache.inner.cache_scope.clone(),
                profile_name: TEST_PROFILE_NAME.into(),
                session_id: session_id.into(),
                working_dir: working_dir.into(),
                last_completed_at: "2026-05-01T00:00:00.000Z".into(),
                last_used_at: "2026-05-01T00:00:00.000Z".into(),
                last_terminal_status: WorkspaceCacheTerminalStatus::Success,
                workspace_trust: WorkspaceTrust::Clean,
                logical_image_size_bytes: image_size_bytes,
                allocated_bytes: allocated_bytes(&current_metadata),
                current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
                drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
                storage_fingerprints: StorageFingerprints::default(),
                state: WorkspaceCacheState::Current,
            },
        )
        .await
        .unwrap();

    let freed = cache.gc(false).await.unwrap();

    assert!(freed > 0);
    assert!(
        !paths.session_workspace_cache_entry_dir(&key).exists(),
        "current directories must not remain as reusable workspace cache entries"
    );
}

#[tokio::test]
async fn gc_counts_nested_current_directory_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let session_id = "sess-1";
    let working_dir = "/workspace";
    let image_size_bytes = 1024 * 1024;
    let key = cache.scoped_cache_key(TEST_PROFILE_NAME, session_id, working_dir, image_size_bytes);
    let current = paths.session_workspace_cache_current_image(&key);
    let nested = current.join("nested");
    tokio::fs::create_dir_all(&nested).await.unwrap();
    tokio::fs::write(
        nested.join("payload"),
        vec![1_u8; image_size_bytes as usize],
    )
    .await
    .unwrap();
    let current_metadata = fs::metadata(&current).await.unwrap();
    cache
        .write_metadata(
            &key,
            run_id,
            WorkspaceCacheMetadata {
                format_version: CACHE_FORMAT_VERSION,
                key_version: CACHE_KEY_VERSION,
                cache_scope: cache.inner.cache_scope.clone(),
                profile_name: TEST_PROFILE_NAME.into(),
                session_id: session_id.into(),
                working_dir: working_dir.into(),
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
            },
        )
        .await
        .unwrap();

    let freed = cache.gc(false).await.unwrap();

    assert!(
        freed >= image_size_bytes,
        "GC must report nested current directory bytes so callers refresh disk stats after cleanup"
    );
    assert!(!paths.session_workspace_cache_entry_dir(&key).exists());
}

#[tokio::test]
async fn gc_keeps_unusable_current_entry_when_entry_lock_is_held() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let key = session_workspace_cache_key("sess-1", "/workspace");
    tokio::fs::create_dir_all(paths.session_workspace_cache_entry_dir(&key))
        .await
        .unwrap();
    tokio::fs::write(
        paths.session_workspace_cache_current_image(&key),
        b"orphan image",
    )
    .await
    .unwrap();
    let _lock = crate::lock::acquire(cache.entry_lock_path(&key))
        .await
        .unwrap();

    let freed = cache.gc(false).await.unwrap();

    assert_eq!(freed, 0);
    assert!(
        paths.session_workspace_cache_entry_dir(&key).exists(),
        "entry locks must protect in-progress promotions from GC removal"
    );
}

#[tokio::test]
async fn gc_keeps_stale_entry_without_current_image_when_entry_lock_is_held() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let key = write_current_cache_entry(
        &cache,
        run_id,
        "sess-1",
        "/workspace",
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    tokio::fs::remove_file(paths.session_workspace_cache_current_image(&key))
        .await
        .unwrap();
    let _lock = crate::lock::acquire(cache.entry_lock_path(&key))
        .await
        .unwrap();

    let freed = cache.gc(false).await.unwrap();

    assert_eq!(freed, 0);
    assert!(
        paths.session_workspace_cache_entry_dir(&key).exists(),
        "entry locks must protect stale entries from GC removal"
    );
}

#[tokio::test]
async fn gc_removes_orphan_temporary_workspace_cache_files() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let cache_key = session_workspace_cache_key("sess-1", "/workspace");
    tokio::fs::create_dir_all(paths.session_workspace_cache_entry_dir(&cache_key))
        .await
        .unwrap();
    let tmp = paths.session_workspace_cache_tmp_image(&cache_key, run_id);
    let metadata_tmp = paths
        .session_workspace_cache_metadata(&cache_key)
        .with_file_name(format!("metadata.json.tmp.{run_id}"));
    tokio::fs::write(&tmp, b"partial image").await.unwrap();
    tokio::fs::write(&metadata_tmp, b"partial metadata")
        .await
        .unwrap();

    let freed = cache.gc(false).await.unwrap();

    assert!(freed > 0);
    assert!(!tmp.exists());
    assert!(!metadata_tmp.exists());
}

#[tokio::test]
async fn gc_removes_orphan_temporary_workspace_cache_directories() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let cache_key = write_current_cache_entry(
        &cache,
        run_id,
        "sess-1",
        "/workspace",
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let tmp = paths.session_workspace_cache_tmp_image(&cache_key, run_id);
    let metadata_tmp = paths
        .session_workspace_cache_metadata(&cache_key)
        .with_file_name(format!("metadata.json.tmp.{run_id}"));
    tokio::fs::create_dir_all(&tmp).await.unwrap();
    tokio::fs::write(tmp.join("partial-image"), b"partial image")
        .await
        .unwrap();
    tokio::fs::create_dir_all(&metadata_tmp).await.unwrap();
    tokio::fs::write(metadata_tmp.join("partial-metadata"), b"partial metadata")
        .await
        .unwrap();

    let freed = cache.gc(false).await.unwrap();

    assert!(freed > 0);
    assert!(!tmp.exists());
    assert!(!metadata_tmp.exists());
    assert!(
        paths
            .session_workspace_cache_current_image(&cache_key)
            .exists()
    );
}

#[tokio::test]
async fn gc_counts_nested_temporary_workspace_cache_directories() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let cache_key = write_current_cache_entry(
        &cache,
        run_id,
        "sess-1",
        "/workspace",
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let tmp = paths.session_workspace_cache_tmp_image(&cache_key, run_id);
    let nested = tmp.join("nested");
    tokio::fs::create_dir_all(&nested).await.unwrap();
    tokio::fs::write(nested.join("partial-image"), vec![1_u8; 4096])
        .await
        .unwrap();

    let freed = cache.gc(false).await.unwrap();

    assert!(
        freed > 0,
        "GC must report bytes freed from nested temporary directories"
    );
    assert!(!tmp.exists());
    assert!(
        paths
            .session_workspace_cache_current_image(&cache_key)
            .exists()
    );
}

#[tokio::test]
async fn gc_keeps_temporary_workspace_cache_files_when_entry_lock_is_held() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let cache_key = session_workspace_cache_key("sess-1", "/workspace");
    tokio::fs::create_dir_all(paths.session_workspace_cache_entry_dir(&cache_key))
        .await
        .unwrap();
    let tmp = paths.session_workspace_cache_tmp_image(&cache_key, run_id);
    let metadata_tmp = paths
        .session_workspace_cache_metadata(&cache_key)
        .with_file_name(format!("metadata.json.tmp.{run_id}"));
    tokio::fs::write(&tmp, b"partial image").await.unwrap();
    tokio::fs::write(&metadata_tmp, b"partial metadata")
        .await
        .unwrap();
    let _lock = crate::lock::acquire(cache.entry_lock_path(&cache_key))
        .await
        .unwrap();

    let freed = cache.gc(false).await.unwrap();

    assert_eq!(freed, 0);
    assert!(tmp.exists());
    assert!(metadata_tmp.exists());
}

#[tokio::test]
async fn sparse_copy_times_out_when_copy_blocks() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("blocked.fifo");
    let destination = dir.path().join("out.ext4");
    let status = std::process::Command::new("mkfifo")
        .arg(&source)
        .status()
        .unwrap();
    assert!(status.success());

    let err = sparse_copy_with_timeout(&source, &destination, std::time::Duration::ZERO)
        .await
        .unwrap_err();

    assert!(err.to_string().contains("timed out after"));
}

#[tokio::test]
async fn promote_skips_symlink_active_image_without_following_it() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let session_id = "sess-active-symlink";
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id,
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: Some(session_id),
            working_dir: "/workspace",
            image_size_bytes: 5,
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
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let session_id = "sess-promote-entry-symlink";
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id,
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: Some(session_id),
            working_dir: "/workspace",
            image_size_bytes: 5,
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
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id,
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: None,
            working_dir: "/workspace",
            image_size_bytes: 5,
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
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id,
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: None,
            working_dir: "/workspace",
            image_size_bytes: 5,
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
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id,
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: None,
            working_dir: "/workspace",
            image_size_bytes: 5,
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
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id,
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: Some("sess-size-mismatch"),
            working_dir: "/workspace",
            image_size_bytes: 16 * 1024 * 1024,
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
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id,
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: Some("sess-capacity-lock"),
            working_dir: "/workspace",
            image_size_bytes: 5,
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
async fn no_session_checkout_can_promote_with_late_discovered_cli_agent_session_id() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id,
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: None,
            working_dir: "/workspace",
            image_size_bytes: 5,
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
    assert!(!lease.can_attempt_promotion(None));
    assert!(lease.can_attempt_promotion(Some("sess-1")));
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
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = SessionWorkspaceCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let session_id = "sess-late-lock-busy";
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id,
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: None,
            working_dir: "/workspace",
            image_size_bytes: 5,
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
            terminal_status: WorkspaceCacheTerminalStatus::Success,
            completed_at: "2026-05-01T00:00:00.000Z".into(),
            storage_fingerprints: StorageFingerprints::default(),
            promotable: true,
        })
        .unwrap();
    let cache_key = session_workspace_cache_key(session_id, "/workspace");
    let _held_lock = crate::lock::acquire(cache.entry_lock_path(&cache_key))
        .await
        .unwrap();

    let promoted = tokio::time::timeout(std::time::Duration::from_secs(1), promotion.promote())
        .await
        .expect("late-session promotion must not block behind another runner's lock")
        .unwrap();

    assert!(!promoted);
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
            run_id,
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            cli_agent_session_id: None,
            working_dir: "/workspace//repo/",
            image_size_bytes: 5,
            workspace_drive_required: false,
        })
        .await;
    let promotion = lease
        .into_promotion_context(WorkspaceImagePromotionRequest {
            run_id,
            sandbox_id,
            cli_agent_session_id_override: Some(session_id),
            terminal_status: WorkspaceCacheTerminalStatus::Success,
            completed_at: "2026-05-01T00:00:00.000Z".into(),
            storage_fingerprints: StorageFingerprints::default(),
            promotable: true,
        })
        .unwrap();

    let active_lease = promotion.into_active_lease(WorkspaceImageActiveLeaseRequest {
        run_id: RunId::new_v4(),
        sandbox_id,
        profile_name: TEST_PROFILE_NAME,
        cli_agent_session_id: Some(session_id),
        working_dir: "/workspace//repo/",
        image_size_bytes: 5,
        workspace_drive_available: true,
    });

    assert_eq!(active_lease.working_dir(), "/workspace/repo");
    assert!(active_lease.can_attempt_promotion(Some(session_id)));
    assert!(
        active_lease
            .into_promotion_context(WorkspaceImagePromotionRequest {
                run_id: RunId::new_v4(),
                sandbox_id,
                cli_agent_session_id_override: Some(session_id),
                terminal_status: WorkspaceCacheTerminalStatus::Success,
                completed_at: "2026-05-01T00:00:01.000Z".into(),
                storage_fingerprints: StorageFingerprints::default(),
                promotable: true,
            })
            .is_some(),
        "reusing an idle sandbox created before the CLI reported a session id must not lose the future cache promotion"
    );
}
