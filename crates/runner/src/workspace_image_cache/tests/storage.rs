use tokio::fs;

use super::super::fs::{
    allocated_bytes, has_copy_headroom, sparse_copy_with_timeout,
    workspace_cache_path_allocated_bytes,
};
use super::super::{CacheBudget, FsStats, GIB, SessionWorkspaceCache};
use crate::paths::RunnerPaths;

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

#[tokio::test]
async fn workspace_cache_path_allocated_bytes_does_not_follow_root_symlink_to_directory() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    tokio::fs::create_dir_all(&target).await.unwrap();
    tokio::fs::write(target.join("payload"), vec![1_u8; 1024 * 1024])
        .await
        .unwrap();
    let link = dir.path().join("link");
    std::os::unix::fs::symlink(&target, &link).unwrap();

    let link_allocated = allocated_bytes(&fs::symlink_metadata(&link).await.unwrap());
    let target_allocated = workspace_cache_path_allocated_bytes(&target).await;
    let actual = workspace_cache_path_allocated_bytes(&link).await;

    assert_eq!(actual, link_allocated);
    assert!(
        target_allocated > link_allocated,
        "test setup should make following the symlink visibly larger"
    );
}

#[tokio::test]
async fn workspace_cache_path_allocated_bytes_does_not_follow_nested_symlink_to_directory() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("root");
    let real_nested = root.join("real-nested");
    tokio::fs::create_dir_all(&real_nested).await.unwrap();
    tokio::fs::write(real_nested.join("payload"), vec![1_u8; 1024 * 1024])
        .await
        .unwrap();
    let external_target = dir.path().join("external-target");
    tokio::fs::create_dir_all(&external_target).await.unwrap();
    tokio::fs::write(external_target.join("payload"), vec![1_u8; 8 * 1024 * 1024])
        .await
        .unwrap();
    let nested_link = root.join("external-link");
    std::os::unix::fs::symlink(&external_target, &nested_link).unwrap();

    let root_allocated = allocated_bytes(&fs::symlink_metadata(&root).await.unwrap());
    let real_nested_allocated = workspace_cache_path_allocated_bytes(&real_nested).await;
    let nested_link_allocated = allocated_bytes(&fs::symlink_metadata(&nested_link).await.unwrap());
    let external_target_allocated = workspace_cache_path_allocated_bytes(&external_target).await;
    let expected = root_allocated
        .saturating_add(real_nested_allocated)
        .saturating_add(nested_link_allocated);

    let actual = workspace_cache_path_allocated_bytes(&root).await;

    assert_eq!(actual, expected);
    assert!(
        external_target_allocated > nested_link_allocated,
        "test setup should make following the nested symlink visibly larger"
    );
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
