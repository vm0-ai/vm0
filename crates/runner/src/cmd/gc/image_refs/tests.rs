use std::time::{Duration, SystemTime};

use super::*;
use crate::cmd::gc::images::gc_nested_images_with_protected_refs;
use crate::cmd::gc::test_support::{old_gc_time, set_mtime, test_home};
use crate::paths::HomePaths;

fn test_hash(ch: char) -> String {
    std::iter::repeat_n(ch, 64).collect()
}

fn write_test_runner_config(
    home: &HomePaths,
    version: &str,
    rootfs_hash: &str,
    snapshot_hash: &str,
) -> PathBuf {
    let config_dir = home.runners_dir().join(version);
    std::fs::create_dir_all(&config_dir).unwrap();
    let config_path = config_dir.join("runner.yaml");
    std::fs::write(
        &config_path,
        format!(
            r#"name: {version}
group: vm0/test
base_dir: /tmp/{version}
ca_dir: /tmp/{version}/ca
firecracker:
  binary: /tmp/firecracker
  kernel: /tmp/vmlinux
profiles:
  vm0/default:
    rootfs_hash: {rootfs_hash}
    snapshot_hash: {snapshot_hash}
    vcpu: 1
    memory_mb: 1024
    rootfs_disk_mb: 8192
    workspace_disk_mb: 8192
server:
  url: https://api.example.test
  token: test-secret-token
"#
        ),
    )
    .unwrap();
    config_path
}

fn create_old_test_snapshot(home: &HomePaths, rootfs_hash: &str, snapshot_hash: &str) -> PathBuf {
    let rootfs_dir = home.images_dir().join(rootfs_hash);
    let snapshot_dir = rootfs_dir.join("snapshots").join(snapshot_hash);
    std::fs::create_dir_all(&snapshot_dir).unwrap();
    std::fs::write(rootfs_dir.join("rootfs.ext4"), b"rootfs").unwrap();
    std::fs::write(snapshot_dir.join("snapshot.bin"), b"snapshot").unwrap();
    let old_time = old_gc_time();
    for path in [&rootfs_dir, &snapshot_dir] {
        std::fs::File::open(path)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(old_time))
            .unwrap();
    }
    snapshot_dir
}

async fn protected_refs_from_configs(config_paths: &[PathBuf]) -> ProtectedImageRefs {
    protected_image_refs_for_gc(config_paths, true).await
}

fn protected_refs_from_pairs(pairs: &[(&str, &str)]) -> ProtectedImageRefs {
    let mut refs = ProtectedImageRefs::new();
    for (rootfs_hash, snapshot_hash) in pairs {
        insert_protected_image_ref(
            &mut refs,
            (*rootfs_hash).to_string(),
            (*snapshot_hash).to_string(),
        );
    }
    refs
}

#[tokio::test]
async fn retained_config_ref_keeps_image_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let rootfs_hash = test_hash('a');
    let snapshot_hash = test_hash('b');
    let snapshot_dir = create_old_test_snapshot(&home, &rootfs_hash, &snapshot_hash);
    let config_path = write_test_runner_config(&home, "release-blue", &rootfs_hash, &snapshot_hash);
    let refs = protected_refs_from_configs(&[config_path]).await;

    let freed = gc_nested_images_with_protected_refs(&home, Some(0), false, &refs)
        .await
        .unwrap();

    assert_eq!(freed.freed_bytes, 0);
    assert!(
        snapshot_dir.exists(),
        "retained config refs must keep the referenced snapshot"
    );
    assert!(home.images_dir().join(&rootfs_hash).exists());
}

#[tokio::test]
async fn only_exact_retained_config_paths_protect_images() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let old_rootfs = test_hash('a');
    let old_snapshot = test_hash('b');
    let new_rootfs = test_hash('c');
    let new_snapshot = test_hash('d');
    let old_snapshot_dir = create_old_test_snapshot(&home, &old_rootfs, &old_snapshot);
    let new_snapshot_dir = create_old_test_snapshot(&home, &new_rootfs, &new_snapshot);
    write_test_runner_config(&home, "release-old", &old_rootfs, &old_snapshot);
    let retained_config =
        write_test_runner_config(&home, "release-new", &new_rootfs, &new_snapshot);
    let refs = protected_refs_from_configs(&[retained_config]).await;

    let freed = gc_nested_images_with_protected_refs(&home, Some(0), false, &refs)
        .await
        .unwrap();

    assert!(freed.freed_bytes > 0);
    assert!(
        new_snapshot_dir.exists(),
        "the explicitly retained config should protect its snapshot"
    );
    assert!(
        !old_snapshot_dir.exists(),
        "a config absent from the retained exact-path set should not protect its snapshot"
    );
}

#[tokio::test]
async fn protected_image_refs_do_not_consume_keep_latest_slots() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let protected_rootfs = test_hash('a');
    let protected_snapshot = test_hash('b');
    let older_rootfs = test_hash('c');
    let older_snapshot = test_hash('d');
    let newer_rootfs = test_hash('e');
    let newer_snapshot = test_hash('f');
    let protected_dir = create_old_test_snapshot(&home, &protected_rootfs, &protected_snapshot);
    let older_dir = create_old_test_snapshot(&home, &older_rootfs, &older_snapshot);
    let newer_dir = create_old_test_snapshot(&home, &newer_rootfs, &newer_snapshot);
    set_mtime(&older_dir, old_gc_time());
    set_mtime(
        &newer_dir,
        SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000),
    );
    let refs = protected_refs_from_pairs(&[(&protected_rootfs, &protected_snapshot)]);

    let freed = gc_nested_images_with_protected_refs(&home, Some(1), false, &refs)
        .await
        .unwrap();

    assert!(freed.freed_bytes > 0);
    assert!(protected_dir.exists(), "protected snapshot must survive");
    assert!(
        newer_dir.exists(),
        "image keep_latest slot should still apply to newest eligible snapshot"
    );
    assert!(
        !older_dir.exists(),
        "older eligible snapshot should be deleted"
    );
}

#[tokio::test]
async fn protected_image_ref_keeps_only_exact_snapshot_pair() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let rootfs_hash = test_hash('a');
    let protected_snapshot = test_hash('b');
    let sibling_snapshot = test_hash('c');
    let protected_dir = create_old_test_snapshot(&home, &rootfs_hash, &protected_snapshot);
    let sibling_dir = create_old_test_snapshot(&home, &rootfs_hash, &sibling_snapshot);
    let refs = protected_refs_from_pairs(&[(&rootfs_hash, &protected_snapshot)]);

    let freed = gc_nested_images_with_protected_refs(&home, Some(0), false, &refs)
        .await
        .unwrap();

    assert!(freed.freed_bytes > 0);
    assert!(
        protected_dir.exists(),
        "exact protected snapshot must survive"
    );
    assert!(
        !sibling_dir.exists(),
        "unreferenced sibling snapshot under same rootfs should remain eligible"
    );
    assert!(
        home.images_dir().join(&rootfs_hash).exists(),
        "rootfs with protected snapshot should survive"
    );
}

#[tokio::test]
async fn unretained_config_does_not_protect_image_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let rootfs_hash = test_hash('a');
    let snapshot_hash = test_hash('b');
    let snapshot_dir = create_old_test_snapshot(&home, &rootfs_hash, &snapshot_hash);
    write_test_runner_config(&home, "release-old", &rootfs_hash, &snapshot_hash);
    let refs = protected_refs_from_configs(&[]).await;

    let freed = gc_nested_images_with_protected_refs(&home, Some(0), false, &refs)
        .await
        .unwrap();

    assert!(freed.freed_bytes > 0);
    assert!(
        !snapshot_dir.exists(),
        "unretained config should not pin image artifacts"
    );
}

#[tokio::test]
async fn malformed_retained_config_makes_image_protection_incomplete() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let config_dir = home.runners_dir().join("release-blue");
    std::fs::create_dir_all(&config_dir).unwrap();
    std::fs::write(
        config_dir.join("runner.yaml"),
        "server:\n  token: should-not-appear-in-errors\nprofiles: [",
    )
    .unwrap();
    let refs = protected_refs_from_configs(&[config_dir.join("runner.yaml")]).await;

    assert!(!refs.is_complete());
}

#[tokio::test]
async fn missing_retained_config_does_not_make_protection_incomplete() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let refs = protected_refs_from_configs(&[home.runners_dir().join("missing/runner.yaml")]).await;

    assert!(refs.is_complete());
    assert!(refs.is_empty());
}

#[tokio::test]
async fn invalid_hash_in_retained_config_makes_image_protection_incomplete() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let config_path =
        write_test_runner_config(&home, "release-blue", "not-a-rootfs-hash", &test_hash('b'));

    let refs = protected_refs_from_configs(&[config_path]).await;

    assert!(!refs.is_complete());
}

#[tokio::test]
async fn incomplete_managed_resource_inventory_makes_image_protection_incomplete() {
    let refs = protected_image_refs_for_gc(&[], false).await;
    assert!(!refs.is_complete());
}

#[tokio::test]
async fn incomplete_protection_inventory_skips_image_gc() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let rootfs_hash = test_hash('a');
    let snapshot_hash = test_hash('b');
    let snapshot_dir = create_old_test_snapshot(&home, &rootfs_hash, &snapshot_hash);

    let report = gc_nested_images_with_protected_refs(
        &home,
        Some(0),
        false,
        &ProtectedImageRefs::incomplete(),
    )
    .await
    .unwrap();

    assert_eq!(report.freed_bytes, 0);
    assert_eq!(report.activity_count, 0);
    assert!(snapshot_dir.exists());
    assert!(home.images_dir().join(rootfs_hash).exists());
}
