use crate::support::run_guest_download_manifest_json;
use serde_json::json;
use std::fs;
use std::os::unix::fs::symlink;
use std::path::Path;

fn cleanup_manifest(
    cleanup_paths: &[&Path],
    preserved_path: Option<&Path>,
) -> serde_json::Result<Vec<u8>> {
    let storage_mounts = preserved_path
        .map(|path| {
            vec![json!({
                "mountPath": path,
                "cached": true,
                "writeback": false
            })]
        })
        .unwrap_or_default();

    serde_json::to_vec(&json!({
        "storageMounts": storage_mounts,
        "cleanupPaths": cleanup_paths
    }))
}

#[test]
fn selective_cleanup_skips_symlinked_root_and_continues() {
    let dir = tempfile::tempdir().unwrap();
    let cleanup_root = dir.path().join("cleanup");
    let later_cleanup = dir.path().join("later-cleanup-path");
    let target = dir.path().join("target");
    let preserved = cleanup_root.join("keep");

    fs::create_dir_all(target.join("keep")).unwrap();
    fs::create_dir_all(target.join("unrelated")).unwrap();
    fs::write(target.join("keep/content.txt"), "keep").unwrap();
    fs::write(target.join("unrelated/content.txt"), "unrelated").unwrap();
    fs::write(target.join("unrelated.txt"), "unrelated").unwrap();
    fs::create_dir_all(&later_cleanup).unwrap();
    fs::write(later_cleanup.join("stale.txt"), "remove").unwrap();
    symlink(&target, &cleanup_root).unwrap();

    let manifest = cleanup_manifest(&[&cleanup_root, &later_cleanup], Some(&preserved)).unwrap();
    let success = run_guest_download_manifest_json(&manifest);

    assert!(success);
    assert!(
        fs::symlink_metadata(&cleanup_root)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(
        fs::read_to_string(target.join("keep/content.txt")).unwrap(),
        "keep"
    );
    assert_eq!(
        fs::read_to_string(target.join("unrelated/content.txt")).unwrap(),
        "unrelated"
    );
    assert_eq!(
        fs::read_to_string(target.join("unrelated.txt")).unwrap(),
        "unrelated"
    );
    assert!(!later_cleanup.exists());
}

#[test]
fn whole_root_cleanup_skips_symlinked_intermediate_component() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("parent");
    let target = dir.path().join("target");
    let target_stale = target.join("stale");
    let alias = parent.join("alias");
    let cleanup_path = alias.join("stale");

    fs::create_dir_all(&parent).unwrap();
    fs::create_dir_all(&target_stale).unwrap();
    fs::write(target_stale.join("content.txt"), "untouched").unwrap();
    symlink(&target, &alias).unwrap();

    let manifest = cleanup_manifest(&[&cleanup_path], None).unwrap();
    let success = run_guest_download_manifest_json(&manifest);

    assert!(success);
    assert!(
        fs::symlink_metadata(&alias)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(
        fs::read_to_string(target_stale.join("content.txt")).unwrap(),
        "untouched"
    );
}

#[test]
fn whole_root_cleanup_removes_final_symlink_without_touching_target() {
    let dir = tempfile::tempdir().unwrap();
    let cleanup_root = dir.path().join("cleanup");
    let target = dir.path().join("target");

    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("content.txt"), "untouched").unwrap();
    symlink(&target, &cleanup_root).unwrap();

    let manifest = cleanup_manifest(&[&cleanup_root], None).unwrap();
    let success = run_guest_download_manifest_json(&manifest);

    assert!(success);
    assert!(fs::symlink_metadata(&cleanup_root).is_err());
    assert_eq!(
        fs::read_to_string(target.join("content.txt")).unwrap(),
        "untouched"
    );
}

#[test]
fn selective_cleanup_preserves_cached_child_in_real_directory() {
    let dir = tempfile::tempdir().unwrap();
    let cleanup_root = dir.path().join("cleanup");
    let preserved = cleanup_root.join("keep");

    fs::create_dir_all(&preserved).unwrap();
    fs::create_dir_all(cleanup_root.join("stale")).unwrap();
    fs::write(preserved.join("content.txt"), "keep").unwrap();
    fs::write(cleanup_root.join("stale/content.txt"), "remove").unwrap();
    fs::write(cleanup_root.join("stale.txt"), "remove").unwrap();

    let manifest = cleanup_manifest(&[&cleanup_root], Some(&preserved)).unwrap();
    let success = run_guest_download_manifest_json(&manifest);

    assert!(success);
    assert_eq!(
        fs::read_to_string(preserved.join("content.txt")).unwrap(),
        "keep"
    );
    assert!(!cleanup_root.join("stale").exists());
    assert!(!cleanup_root.join("stale.txt").exists());
}

#[test]
fn cleanup_preserves_cached_path_across_equivalent_manifest_spellings() {
    let dir = tempfile::tempdir().unwrap();
    let alias = dir.path().join("alias");
    let cached = dir.path().join("cache");
    let cleanup_path = alias.join("..").join("cache");

    fs::create_dir_all(&alias).unwrap();
    fs::create_dir_all(&cached).unwrap();
    fs::write(cached.join("content.txt"), "keep").unwrap();

    let manifest = cleanup_manifest(&[&cleanup_path], Some(&cached)).unwrap();
    let success = run_guest_download_manifest_json(&manifest);

    assert!(success);
    assert_eq!(
        fs::read_to_string(cached.join("content.txt")).unwrap(),
        "keep"
    );
}

#[test]
fn cleanup_preserves_path_nested_below_cached_root() {
    let dir = tempfile::tempdir().unwrap();
    let alias = dir.path().join("alias");
    let cached = dir.path().join("cache");
    let nested = cached.join("nested");
    let cleanup_path = alias.join("..").join("cache").join("nested");

    fs::create_dir_all(&alias).unwrap();
    fs::create_dir_all(&nested).unwrap();
    fs::write(nested.join("content.txt"), "keep").unwrap();

    let manifest = cleanup_manifest(&[&cleanup_path], Some(&cached)).unwrap();
    let success = run_guest_download_manifest_json(&manifest);

    assert!(success);
    assert_eq!(
        fs::read_to_string(nested.join("content.txt")).unwrap(),
        "keep"
    );
}

#[test]
fn cleanup_normalization_does_not_bypass_intermediate_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let alias = dir.path().join("alias");
    let target = dir.path().join("target");
    let cache = dir.path().join("cache");
    let cleanup_path = alias.join("..").join("cache");

    fs::create_dir_all(&target).unwrap();
    fs::create_dir_all(&cache).unwrap();
    fs::write(cache.join("content.txt"), "keep").unwrap();
    symlink(&target, &alias).unwrap();

    let manifest = cleanup_manifest(&[&cleanup_path], None).unwrap();
    let success = run_guest_download_manifest_json(&manifest);

    assert!(success);
    assert_eq!(
        fs::read_to_string(cache.join("content.txt")).unwrap(),
        "keep"
    );
}
