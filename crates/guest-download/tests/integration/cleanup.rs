use crate::support::run_guest_download_manifest_json;
use serde_json::json;
use std::fs;
use std::os::unix::fs::symlink;
use std::path::Path;

fn cleanup_manifest(
    cleanup_path: &Path,
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
        "cleanupPaths": [cleanup_path]
    }))
}

#[test]
fn selective_cleanup_rejects_symlinked_root_without_touching_target() {
    let dir = tempfile::tempdir().unwrap();
    let cleanup_root = dir.path().join("cleanup");
    let target = dir.path().join("target");
    let preserved = cleanup_root.join("keep");

    fs::create_dir_all(target.join("keep")).unwrap();
    fs::create_dir_all(target.join("unrelated")).unwrap();
    fs::write(target.join("keep/content.txt"), "keep").unwrap();
    fs::write(target.join("unrelated/content.txt"), "unrelated").unwrap();
    fs::write(target.join("unrelated.txt"), "unrelated").unwrap();
    symlink(&target, &cleanup_root).unwrap();

    let manifest = cleanup_manifest(&cleanup_root, Some(&preserved)).unwrap();
    let success = run_guest_download_manifest_json(&manifest);

    assert!(!success);
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
}

#[test]
fn whole_root_cleanup_rejects_symlinked_intermediate_component() {
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

    let manifest = cleanup_manifest(&cleanup_path, None).unwrap();
    let success = run_guest_download_manifest_json(&manifest);

    assert!(!success);
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

    let manifest = cleanup_manifest(&cleanup_root, None).unwrap();
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

    let manifest = cleanup_manifest(&cleanup_root, Some(&preserved)).unwrap();
    let success = run_guest_download_manifest_json(&manifest);

    assert!(success);
    assert_eq!(
        fs::read_to_string(preserved.join("content.txt")).unwrap(),
        "keep"
    );
    assert!(!cleanup_root.join("stale").exists());
    assert!(!cleanup_root.join("stale.txt").exists());
}
