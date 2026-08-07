use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::{Duration, SystemTime};

use super::*;
use crate::cmd::gc::GC_MIN_AGE;
use crate::cmd::gc::images::gc_nested_images_with_protected_refs;
use crate::cmd::gc::test_support::{old_gc_time, set_mtime, test_home};
use crate::cmd::gc::versions::{
    analyze_version_gc, analyze_version_gc_with_injected_config_scan_error,
    analyze_version_gc_with_injected_scan_error,
};
use crate::test_fixtures::ignored_child::{
    ignored_child_test_env_guard_enabled, run_ignored_child_test,
};

const ENABLED_SERVICE_SCENARIO_ENV: &str = "VM0_RUN_GC_ENABLED_SERVICE_SCENARIO";
const ENABLED_SERVICE_CONFIG_ENV: &str = "VM0_RUN_GC_ENABLED_SERVICE_CONFIG";
const ENABLED_SERVICE_HOME_ENV: &str = "VM0_RUN_GC_ENABLED_SERVICE_HOME";
const ENABLED_SERVICE_SYSTEM_DIR_ENV: &str = "VM0_RUN_GC_ENABLED_SERVICE_SYSTEM_DIR";
const ENABLED_SERVICE_INVOCATIONS_ENV: &str = "VM0_RUN_GC_ENABLED_SERVICE_INVOCATIONS";
const ENABLED_SERVICE_CHILD_TEST: &str =
    "cmd::gc::image_refs::tests::enabled_service_systemctl_child";
const FAKE_SYSTEMCTL: &str = r#"#!/bin/sh
printf '%s\n' "$*" >> "$VM0_RUN_GC_ENABLED_SERVICE_INVOCATIONS"

if [ "$1" = "is-enabled" ]; then
  if [ "$VM0_RUN_GC_ENABLED_SERVICE_SCENARIO" = "enablement-error" ]; then
    printf '%s\n' 'cannot determine unit file state' >&2
    exit 1
  fi
  printf '%s\n' 'enabled'
  exit 0
fi

if [ "$1" = "--no-pager" ] && [ "$2" = "cat" ] && [ "$3" = "--" ]; then
  case "$VM0_RUN_GC_ENABLED_SERVICE_SCENARIO" in
    cat-error)
      printf '%s\n' 'cannot read selected drop-in' >&2
      exit 1
      ;;
    cat-warning)
      printf '%s\n' '[Service]' 'ExecStart=/usr/bin/runner start --config /etc/stale.yaml'
      printf '%s\n' 'unit files changed on disk; daemon-reload required' >&2
      exit 0
      ;;
    unparseable)
      printf '%s\n' '[Service]' 'ExecStart=/usr/bin/true'
      exit 0
      ;;
    effective)
      printf '%s\n' \
        '# /etc/systemd/system/vm0-runner-test.service' \
        '[Service]' \
        'ExecStart=/usr/bin/runner start --config /etc/base.yaml' \
        '# /usr/lib/systemd/system/vm0-runner-.service.d/10-vendor.conf' \
        '[Service]' \
        'ExecStart=' \
        'ExecStart=/usr/bin/runner start --config /etc/vendor.yaml' \
        '# /run/systemd/system/vm0-runner-test.service.d/20-runtime.conf' \
        '[Service]' \
        'ExecStart=' \
        "ExecStart=/usr/bin/runner start --config $VM0_RUN_GC_ENABLED_SERVICE_CONFIG"
      exit 0
      ;;
  esac
fi

printf '%s\n' "unexpected fake systemctl invocation: $*" >&2
exit 2
"#;

fn age_version_past_gc_min_age(home: &HomePaths, name: &str) {
    let old_time = SystemTime::now() - Duration::from_secs(GC_MIN_AGE.as_secs() + 60);
    for path in [
        home.bin_dir().join(name),
        home.bin_dir().join(name).join("runner"),
        home.runners_dir().join(name),
        home.runners_dir().join(name).join("runner.yaml"),
    ] {
        if path.exists() {
            std::fs::File::open(path)
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(old_time))
                .unwrap();
        }
    }
}

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

fn create_test_version_with_config(
    home: &HomePaths,
    version: &str,
    rootfs_hash: &str,
    snapshot_hash: &str,
) -> PathBuf {
    std::fs::create_dir_all(home.bin_dir().join(version)).unwrap();
    let config_path = write_test_runner_config(home, version, rootfs_hash, snapshot_hash);
    age_version_past_gc_min_age(home, version);
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

async fn protected_refs_from_versions(
    home: &HomePaths,
    protect: Option<&str>,
    keep_latest: Option<usize>,
) -> ProtectedImageRefs {
    let analysis = analyze_version_gc(home, protect, keep_latest)
        .await
        .unwrap();
    let mut refs = ProtectedImageRefs::new();
    collect_retained_version_image_refs(home, &analysis, &mut refs).await;
    refs
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
async fn protected_version_config_ref_keeps_image_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let rootfs_hash = test_hash('a');
    let snapshot_hash = test_hash('b');
    let snapshot_dir = create_old_test_snapshot(&home, &rootfs_hash, &snapshot_hash);
    create_test_version_with_config(&home, "v1.0.0", &rootfs_hash, &snapshot_hash);
    let refs = protected_refs_from_versions(&home, Some("v1.0.0"), None).await;

    let freed = gc_nested_images_with_protected_refs(&home, Some(0), false, &refs)
        .await
        .unwrap();

    assert_eq!(freed.freed_bytes, 0);
    assert!(
        snapshot_dir.exists(),
        "protect-version config refs must keep the referenced snapshot"
    );
    assert!(home.images_dir().join(&rootfs_hash).exists());
}

#[tokio::test]
async fn protected_config_only_version_ref_keeps_image_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let version = "v1.0.0";
    let rootfs_hash = test_hash('a');
    let snapshot_hash = test_hash('b');
    let snapshot_dir = create_old_test_snapshot(&home, &rootfs_hash, &snapshot_hash);
    write_test_runner_config(&home, version, &rootfs_hash, &snapshot_hash);
    let refs = protected_refs_from_versions(&home, Some(version), None).await;

    let freed = gc_nested_images_with_protected_refs(&home, Some(0), false, &refs)
        .await
        .unwrap();

    assert_eq!(freed.freed_bytes, 0);
    assert!(
        snapshot_dir.exists(),
        "retained config-only version must protect its referenced snapshot"
    );
}

#[tokio::test]
async fn keep_latest_version_config_ref_keeps_image_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let old_rootfs = test_hash('a');
    let old_snapshot = test_hash('b');
    let new_rootfs = test_hash('c');
    let new_snapshot = test_hash('d');
    let old_snapshot_dir = create_old_test_snapshot(&home, &old_rootfs, &old_snapshot);
    let new_snapshot_dir = create_old_test_snapshot(&home, &new_rootfs, &new_snapshot);
    create_test_version_with_config(&home, "v1.0.0", &old_rootfs, &old_snapshot);
    create_test_version_with_config(&home, "v2.0.0", &new_rootfs, &new_snapshot);
    let refs = protected_refs_from_versions(&home, None, Some(1)).await;

    let freed = gc_nested_images_with_protected_refs(&home, Some(0), false, &refs)
        .await
        .unwrap();

    assert!(freed.freed_bytes > 0);
    assert!(
        new_snapshot_dir.exists(),
        "newest retained version should protect its config snapshot"
    );
    assert!(
        !old_snapshot_dir.exists(),
        "removable version config should not protect its snapshot"
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
async fn removable_version_config_does_not_protect_image_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let rootfs_hash = test_hash('a');
    let snapshot_hash = test_hash('b');
    let snapshot_dir = create_old_test_snapshot(&home, &rootfs_hash, &snapshot_hash);
    create_test_version_with_config(&home, "v1.0.0", &rootfs_hash, &snapshot_hash);
    let refs = protected_refs_from_versions(&home, None, None).await;

    let freed = gc_nested_images_with_protected_refs(&home, Some(0), false, &refs)
        .await
        .unwrap();

    assert!(freed.freed_bytes > 0);
    assert!(
        !snapshot_dir.exists(),
        "old removable version config should not pin image artifacts"
    );
}

#[tokio::test]
async fn malformed_retained_version_config_is_ignored_for_image_refs() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let version = "v1.0.0";
    std::fs::create_dir_all(home.bin_dir().join(version)).unwrap();
    let config_dir = home.runners_dir().join(version);
    std::fs::create_dir_all(&config_dir).unwrap();
    std::fs::write(
        config_dir.join("runner.yaml"),
        "server:\n  token: should-not-appear-in-errors\nprofiles: [",
    )
    .unwrap();
    age_version_past_gc_min_age(&home, version);

    let refs = protected_refs_from_versions(&home, Some(version), None).await;

    assert!(
        refs.is_empty(),
        "malformed retained config should be skipped instead of protecting images"
    );
}

#[tokio::test]
async fn service_config_image_ref_keeps_image_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let rootfs_hash = test_hash('a');
    let snapshot_hash = test_hash('b');
    let snapshot_dir = create_old_test_snapshot(&home, &rootfs_hash, &snapshot_hash);
    let config_path =
        write_test_runner_config(&home, "service-config", &rootfs_hash, &snapshot_hash);
    let mut refs = ProtectedImageRefs::new();
    collect_config_image_refs(&config_path, "enabled service", &mut refs).await;

    let freed = gc_nested_images_with_protected_refs(&home, Some(0), false, &refs)
        .await
        .unwrap();

    assert_eq!(freed.freed_bytes, 0);
    assert!(
        snapshot_dir.exists(),
        "enabled service config refs must keep the referenced snapshot"
    );
}

#[tokio::test]
async fn enabled_service_directory_scan_reports_iteration_error() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("unrelated-a.service"), "").unwrap();
    std::fs::write(dir.path().join("unrelated-b.service"), "").unwrap();
    let mut entry_reader = GcDirEntryReader::failing_after(1);

    let scan = enabled_runner_service_config_paths_with_reader(dir.path(), &mut entry_reader).await;

    assert!(!scan.inventory_complete);
    assert!(scan.paths.is_empty());
}

#[tokio::test]
async fn effective_enabled_service_config_ref_keeps_image_snapshot() {
    let invocations = run_enabled_service_scenario("effective").await;

    assert_eq!(
        invocations,
        vec![
            "is-enabled vm0-runner-test.service",
            "--no-pager cat -- vm0-runner-test.service",
        ]
    );
}

#[tokio::test]
async fn enabled_service_discovery_failures_make_inventory_incomplete() {
    for scenario in ["enablement-error", "cat-error", "cat-warning"] {
        run_enabled_service_scenario(scenario).await;
    }
}

#[tokio::test]
async fn readable_unit_without_runner_config_remains_best_effort() {
    run_enabled_service_scenario("unparseable").await;
}

async fn run_enabled_service_scenario(scenario: &str) -> Vec<String> {
    let dir = tempfile::tempdir().unwrap();
    let fake_systemctl = dir.path().join("systemctl");
    std::fs::write(&fake_systemctl, FAKE_SYSTEMCTL).unwrap();
    let mut permissions = std::fs::metadata(&fake_systemctl).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&fake_systemctl, permissions).unwrap();

    let system_dir = dir.path().join("system");
    std::fs::create_dir(&system_dir).unwrap();
    std::fs::write(system_dir.join("vm0-runner-test.service"), "").unwrap();

    let home_root = dir.path().join("home");
    let home = test_home(&home_root);
    let rootfs_hash = test_hash('a');
    let snapshot_hash = test_hash('b');
    create_old_test_snapshot(&home, &rootfs_hash, &snapshot_hash);
    let config_path = write_test_runner_config(&home, "effective", &rootfs_hash, &snapshot_hash);

    let invocations_path = dir.path().join("invocations");
    run_ignored_child_test(
        ENABLED_SERVICE_CHILD_TEST,
        (ENABLED_SERVICE_SCENARIO_ENV, scenario),
        &[
            ("PATH", Some(utf8_path(dir.path()))),
            (ENABLED_SERVICE_CONFIG_ENV, Some(utf8_path(&config_path))),
            (ENABLED_SERVICE_HOME_ENV, Some(utf8_path(&home_root))),
            (ENABLED_SERVICE_SYSTEM_DIR_ENV, Some(utf8_path(&system_dir))),
            (
                ENABLED_SERVICE_INVOCATIONS_ENV,
                Some(utf8_path(&invocations_path)),
            ),
        ],
        Duration::from_secs(10),
    )
    .await;

    std::fs::read_to_string(invocations_path)
        .unwrap()
        .lines()
        .map(str::to_string)
        .collect()
}

fn utf8_path(path: &Path) -> &str {
    path.to_str().expect("temporary path must be UTF-8")
}

#[tokio::test]
#[ignore = "spawned by enabled service image ref systemctl tests"]
async fn enabled_service_systemctl_child() {
    let Ok(scenario) = std::env::var(ENABLED_SERVICE_SCENARIO_ENV) else {
        return;
    };
    if !ignored_child_test_env_guard_enabled((ENABLED_SERVICE_SCENARIO_ENV, &scenario)) {
        return;
    }

    let system_dir = PathBuf::from(std::env::var(ENABLED_SERVICE_SYSTEM_DIR_ENV).unwrap());
    match scenario.as_str() {
        "effective" => {
            let home = test_home(Path::new(&std::env::var(ENABLED_SERVICE_HOME_ENV).unwrap()));
            let rootfs_hash = test_hash('a');
            let snapshot_hash = test_hash('b');
            let snapshot_dir = home
                .images_dir()
                .join(&rootfs_hash)
                .join("snapshots")
                .join(&snapshot_hash);
            let mut refs = ProtectedImageRefs::new();

            assert!(collect_enabled_service_image_refs_from_dir(&system_dir, &mut refs).await);
            let report = gc_nested_images_with_protected_refs(&home, Some(0), false, &refs)
                .await
                .unwrap();

            assert_eq!(report.freed_bytes, 0);
            assert!(
                snapshot_dir.exists(),
                "effective enabled-service config must protect its image pair"
            );
        }
        "enablement-error" | "cat-error" | "cat-warning" => {
            let scan = enabled_runner_service_config_paths(&system_dir).await;

            assert!(!scan.inventory_complete);
            assert!(scan.paths.is_empty());
        }
        "unparseable" => {
            let scan = enabled_runner_service_config_paths(&system_dir).await;

            assert!(scan.inventory_complete);
            assert!(scan.paths.is_empty());
        }
        unexpected => panic!("unexpected enabled service scenario: {unexpected}"),
    }
}

#[tokio::test]
async fn incomplete_version_scan_makes_protection_inventory_incomplete() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    for version in ["v1.0.0", "v2.0.0"] {
        std::fs::create_dir_all(home.bin_dir().join(version)).unwrap();
    }
    let analysis = analyze_version_gc_with_injected_scan_error(&home, None, None, 1)
        .await
        .unwrap();

    let refs = protected_image_refs_for_gc(&home, &analysis).await;

    assert!(!refs.is_complete());
}

#[tokio::test]
async fn incomplete_config_scan_makes_protection_inventory_incomplete() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.runners_dir()).unwrap();
    let analysis = analyze_version_gc_with_injected_config_scan_error(&home, None, None, 0)
        .await
        .unwrap();

    let refs = protected_image_refs_for_gc(&home, &analysis).await;

    assert!(!analysis.directory_scan_complete());
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
