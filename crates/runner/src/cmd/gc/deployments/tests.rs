use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

use super::*;
use crate::live_runner_instances::LiveRunnerInstanceMetadata;
use crate::test_fixtures::ignored_child::{
    ignored_child_test_env_guard_enabled, run_ignored_child_test,
};

const DEPLOYMENT_CHILD_TEST: &str =
    "cmd::gc::deployments::tests::managed_resource_gc_systemctl_child";
const DEPLOYMENT_SCENARIO_ENV: &str = "OKOU_RUN_GC_DEPLOYMENT_SCENARIO";
const DEPLOYMENT_HOME_ENV: &str = "OKOU_RUN_GC_DEPLOYMENT_HOME";
const DEPLOYMENT_INVOCATIONS_ENV: &str = "OKOU_RUN_GC_DEPLOYMENT_INVOCATIONS";
const SNAPSHOT_DIGEST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FAKE_SYSTEMCTL: &str = r#"#!/bin/sh
printf '%s\n' "$*" >> "$OKOU_RUN_GC_DEPLOYMENT_INVOCATIONS"

if [ "$1" = "--no-pager" ] && [ "$2" = "cat" ] && [ "$3" = "--" ]; then
  unit=$4
  suffix=${unit#vm0-runner-}
  suffix=${suffix%.service}
  case "$OKOU_RUN_GC_DEPLOYMENT_SCENARIO" in
    direct|keep-service|transient|uninstall-failure|remove-failure|becomes-recent)
      binary_dirname=binary-opaque
      config="$OKOU_RUN_GC_DEPLOYMENT_HOME/runners/config-opaque/runner.yaml"
      ;;
    snapshot)
      binary_dirname=binary-opaque
      config="$OKOU_RUN_GC_DEPLOYMENT_HOME/runners/config-opaque/service-config-snapshots/service-blue-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.yaml"
      ;;
    invalid-snapshot)
      binary_dirname=binary-opaque
      config="$OKOU_RUN_GC_DEPLOYMENT_HOME/runners/config-opaque/service-config-snapshots/other-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.yaml"
      ;;
    external-config)
      binary_dirname=binary-opaque
      config="$OKOU_RUN_GC_DEPLOYMENT_HOME/operator/runner.yaml"
      ;;
    invalid-base-dir)
      binary_dirname=binary-opaque
      config="$OKOU_RUN_GC_DEPLOYMENT_HOME/operator/runner.yaml"
      ;;
    shared)
      binary_dirname=shared-bin
      config="$OKOU_RUN_GC_DEPLOYMENT_HOME/runners/shared-runner/runner.yaml"
      ;;
    external-executable)
      printf '%s\n' \
        '[Service]' \
        "ExecStart=$OKOU_RUN_GC_DEPLOYMENT_HOME/outside/runner start --config $OKOU_RUN_GC_DEPLOYMENT_HOME/runners/config-opaque/runner.yaml"
      exit 0
      ;;
    invalid-managed-executable)
      printf '%s\n' \
        '[Service]' \
        "ExecStart=$OKOU_RUN_GC_DEPLOYMENT_HOME/bin/binary-opaque/nested/runner start --config $OKOU_RUN_GC_DEPLOYMENT_HOME/runners/config-opaque/runner.yaml"
      exit 0
      ;;
    *)
      printf '%s\n' "unexpected deployment scenario: $OKOU_RUN_GC_DEPLOYMENT_SCENARIO" >&2
      exit 2
      ;;
  esac
  printf '%s\n' \
    '[Service]' \
    "ExecStart=$OKOU_RUN_GC_DEPLOYMENT_HOME/bin/$binary_dirname/runner start --config $config"
  exit 0
fi

if [ "$1" = "show" ]; then
  if [ "$OKOU_RUN_GC_DEPLOYMENT_SCENARIO" = "shared" ] && \
     [ "$2" = "vm0-runner-service-a.service" ]; then
    printf '%s\n' 'LoadState=loaded' 'ActiveState=deactivating'
    exit 0
  fi
  printf '%s\n' 'LoadState=loaded' 'ActiveState=inactive'
  exit 0
fi

printf '%s\n' "unexpected fake systemctl invocation: $*" >&2
exit 2
"#;

fn successful_fake_uninstall_service_unit(
    _unit: &service::RunnerServiceUnit,
) -> ServiceUninstallFuture<'_> {
    Box::pin(async { Ok(()) })
}

fn unexpected_fake_uninstall_service_unit(
    _unit: &service::RunnerServiceUnit,
) -> ServiceUninstallFuture<'_> {
    Box::pin(async { panic!("reference-only service must not be uninstalled") })
}

fn failing_fake_uninstall_service_unit(
    _unit: &service::RunnerServiceUnit,
) -> ServiceUninstallFuture<'_> {
    Box::pin(async { Err(RunnerError::Internal("injected uninstall failure".into())) })
}

fn touching_fake_uninstall_service_unit(
    _unit: &service::RunnerServiceUnit,
) -> ServiceUninstallFuture<'_> {
    Box::pin(async {
        let home = HomePaths::with_root(PathBuf::from(std::env::var(DEPLOYMENT_HOME_ENV).unwrap()));
        set_tree_mtime(&home.bin_dir().join("binary-opaque"), SystemTime::now());
        set_tree_mtime(&home.runners_dir().join("config-opaque"), SystemTime::now());
        Ok(())
    })
}

fn failing_remove_dir_all(_path: &Path) -> RemoveDirAllFuture<'_> {
    Box::pin(async {
        Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "injected directory removal failure",
        ))
    })
}

fn install_fake_systemctl(dir: &Path) {
    let fake_systemctl = dir.join("systemctl");
    std::fs::write(&fake_systemctl, FAKE_SYSTEMCTL).unwrap();
    let mut permissions = std::fs::metadata(&fake_systemctl).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(fake_systemctl, permissions).unwrap();
}

fn create_managed_resources(
    home: &HomePaths,
    bin_dirname: &str,
    runner_dirname: &str,
    mtime: SystemTime,
) {
    let bin_dir = home.bin_dir().join(bin_dirname);
    let runner_dir = home.runners_dir().join(runner_dirname);
    std::fs::create_dir_all(&bin_dir).unwrap();
    std::fs::create_dir_all(&runner_dir).unwrap();
    std::fs::write(bin_dir.join(RUNNER_BINARY_NAME), "runner").unwrap();
    write_config(&runner_dir.join(RUNNER_CONFIG_NAME), &runner_dir);
    set_tree_mtime(&bin_dir, mtime);
    set_tree_mtime(&runner_dir, mtime);
}

fn write_config(path: &Path, base_dir: &Path) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        path,
        format!("base_dir: {}\nprofiles: {{}}\n", base_dir.display()),
    )
    .unwrap();
}

fn set_tree_mtime(path: &Path, mtime: SystemTime) {
    if path.is_dir() {
        for entry in std::fs::read_dir(path).unwrap() {
            set_tree_mtime(&entry.unwrap().path(), mtime);
        }
    }
    std::fs::File::open(path)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(mtime))
        .unwrap();
}

fn old_mtime(seconds: u64) -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)
}

async fn gc_managed_resources(
    home: &HomePaths,
    service_suffixes: (&[String], &[String]),
    keep_service_suffixes: &BTreeSet<String>,
    keep_bin_dirnames: &BTreeSet<String>,
    keep_runner_dirnames: &BTreeSet<String>,
    keep_latest: Option<usize>,
    dry_run: bool,
) -> RunnerResult<ManagedResourceGcOutcome> {
    let (persistent_service_suffixes, reference_only_service_suffixes) = service_suffixes;
    gc_managed_resources_with_operations(
        home,
        ManagedResourceGcRequest {
            persistent_service_suffixes,
            reference_only_service_suffixes,
            keep_service_suffixes,
            keep_bin_dirnames,
            keep_runner_dirnames,
            keep_latest,
            service_inventory_complete: true,
            dry_run,
        },
        ManagedResourceGcOperations {
            uninstall_service: successful_fake_uninstall_service_unit,
            remove_dir_all: real_remove_dir_all,
        },
    )
    .await
}

async fn run_systemctl_scenario(dir: &Path, home: &HomePaths, scenario: &str) {
    let invocations_path = dir.join("invocations");
    run_ignored_child_test(
        DEPLOYMENT_CHILD_TEST,
        (DEPLOYMENT_SCENARIO_ENV, scenario),
        &[
            ("PATH", Some(dir.to_str().unwrap())),
            (
                DEPLOYMENT_HOME_ENV,
                Some(home.bin_dir().parent().unwrap().to_str().unwrap()),
            ),
            (
                DEPLOYMENT_INVOCATIONS_ENV,
                Some(invocations_path.to_str().unwrap()),
            ),
        ],
        Duration::from_secs(10),
    )
    .await;
}

#[tokio::test]
async fn no_services_removes_old_managed_directories() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    create_managed_resources(&home, "orphan-bin", "orphan-runner", old_mtime(1_000_000));

    let outcome = gc_managed_resources(
        &home,
        (&[], &[]),
        &BTreeSet::new(),
        &BTreeSet::new(),
        &BTreeSet::new(),
        Some(0),
        false,
    )
    .await
    .unwrap();
    let (report, retained_config_paths, inventory_complete) = outcome.into_parts();

    assert_eq!(report.activity_count, 2);
    assert!(retained_config_paths.is_empty());
    assert!(inventory_complete);
    assert!(!home.bin_dir().join("orphan-bin").exists());
    assert!(!home.runners_dir().join("orphan-runner").exists());
}

#[tokio::test]
async fn keep_latest_is_independent_for_binary_and_runner_roots() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    create_managed_resources(&home, "bin-old", "runner-new", old_mtime(1_000_000));
    create_managed_resources(&home, "bin-new", "runner-old", old_mtime(2_000_000));
    set_tree_mtime(&home.runners_dir().join("runner-new"), old_mtime(3_000_000));

    let outcome = gc_managed_resources(
        &home,
        (&[], &[]),
        &BTreeSet::new(),
        &BTreeSet::new(),
        &BTreeSet::new(),
        Some(1),
        false,
    )
    .await
    .unwrap();
    let (report, retained_config_paths, inventory_complete) = outcome.into_parts();

    assert_eq!(report.activity_count, 2);
    assert_eq!(
        retained_config_paths,
        [home.runners_dir().join("runner-new/runner.yaml")]
    );
    assert!(inventory_complete);
    assert!(!home.bin_dir().join("bin-old").exists());
    assert!(home.bin_dir().join("bin-new").exists());
    assert!(home.runners_dir().join("runner-new").exists());
    assert!(!home.runners_dir().join("runner-old").exists());
}

#[tokio::test]
async fn explicit_keeps_are_independent_for_all_three_namespaces() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    create_managed_resources(&home, "keep-bin", "remove-runner", old_mtime(1_000_000));
    create_managed_resources(&home, "remove-bin", "keep-runner", old_mtime(1_000_000));

    let outcome = gc_managed_resources(
        &home,
        (&[], &[]),
        &BTreeSet::from(["unrelated-service".to_string()]),
        &BTreeSet::from(["keep-bin".to_string()]),
        &BTreeSet::from(["keep-runner".to_string()]),
        Some(0),
        false,
    )
    .await
    .unwrap();
    let (report, retained_config_paths, inventory_complete) = outcome.into_parts();

    assert_eq!(report.activity_count, 2);
    assert_eq!(
        retained_config_paths,
        [home.runners_dir().join("keep-runner/runner.yaml")]
    );
    assert!(inventory_complete);
    assert!(home.bin_dir().join("keep-bin").exists());
    assert!(!home.bin_dir().join("remove-bin").exists());
    assert!(!home.runners_dir().join("remove-runner").exists());
    assert!(home.runners_dir().join("keep-runner").exists());
}

#[tokio::test]
async fn recent_managed_directories_are_retained_without_services() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    create_managed_resources(&home, "recent-bin", "recent-runner", SystemTime::now());

    let outcome = gc_managed_resources(
        &home,
        (&[], &[]),
        &BTreeSet::new(),
        &BTreeSet::new(),
        &BTreeSet::new(),
        Some(0),
        false,
    )
    .await
    .unwrap();
    let (report, retained_config_paths, inventory_complete) = outcome.into_parts();

    assert!(report.is_empty());
    assert_eq!(
        retained_config_paths,
        [home.runners_dir().join("recent-runner/runner.yaml")]
    );
    assert!(inventory_complete);
}

#[tokio::test]
async fn dry_run_reports_old_directories_without_removing_them() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    create_managed_resources(&home, "orphan-bin", "orphan-runner", old_mtime(1_000_000));

    let outcome = gc_managed_resources(
        &home,
        (&[], &[]),
        &BTreeSet::new(),
        &BTreeSet::new(),
        &BTreeSet::new(),
        Some(0),
        true,
    )
    .await
    .unwrap();
    let (report, _, inventory_complete) = outcome.into_parts();

    assert_eq!(report.activity_count, 2);
    assert!(inventory_complete);
    assert!(home.bin_dir().join("orphan-bin").exists());
    assert!(home.runners_dir().join("orphan-runner").exists());
}

#[tokio::test]
async fn busy_service_lock_makes_the_complete_inventory_unavailable() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let unit = service::RunnerServiceUnit::from_suffix("service-blue").unwrap();
    let _held = crate::lock::acquire(unit.lock_path(&home)).await.unwrap();

    let outcome = gc_managed_resources(
        &home,
        (&["service-blue".to_string()], &[]),
        &BTreeSet::new(),
        &BTreeSet::new(),
        &BTreeSet::new(),
        Some(0),
        true,
    )
    .await
    .unwrap();
    let (report, retained_config_paths, inventory_complete) = outcome.into_parts();

    assert!(report.is_empty());
    assert!(retained_config_paths.is_empty());
    assert!(!inventory_complete);
}

#[tokio::test]
async fn held_base_dir_lock_retains_only_its_runner_directory() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    create_managed_resources(&home, "orphan-bin", "live-runner", old_mtime(1_000_000));
    let runner_dir = home
        .runners_dir()
        .join("live-runner")
        .canonicalize()
        .unwrap();
    let _held = crate::lock::acquire(home.base_dir_lock(&runner_dir))
        .await
        .unwrap();

    let outcome = gc_managed_resources(
        &home,
        (&[], &[]),
        &BTreeSet::new(),
        &BTreeSet::new(),
        &BTreeSet::new(),
        Some(0),
        false,
    )
    .await
    .unwrap();
    let (report, retained_config_paths, inventory_complete) = outcome.into_parts();

    assert_eq!(report.activity_count, 1);
    assert_eq!(
        retained_config_paths,
        [home.runners_dir().join("live-runner/runner.yaml")]
    );
    assert!(inventory_complete);
    assert!(!home.bin_dir().join("orphan-bin").exists());
    assert!(home.runners_dir().join("live-runner").exists());
}

#[tokio::test]
async fn live_instance_retains_its_managed_runner_directory() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    create_managed_resources(&home, "orphan-bin", "live-runner", old_mtime(1_000_000));
    let runner_dir = home
        .runners_dir()
        .join("live-runner")
        .canonicalize()
        .unwrap();
    let handle = crate::live_runner_instances::publish(
        &home,
        LiveRunnerInstanceMetadata {
            config_path: runner_dir.join(RUNNER_CONFIG_NAME),
            base_dir: runner_dir,
            runner_group: "test".to_string(),
            subcommand: "start".to_string(),
        },
    )
    .await
    .unwrap();

    let outcome = gc_managed_resources(
        &home,
        (&[], &[]),
        &BTreeSet::new(),
        &BTreeSet::new(),
        &BTreeSet::new(),
        Some(0),
        false,
    )
    .await
    .unwrap();
    let (report, retained_config_paths, inventory_complete) = outcome.into_parts();

    assert_eq!(report.activity_count, 1);
    assert_eq!(
        retained_config_paths,
        [home.runners_dir().join("live-runner/runner.yaml")]
    );
    assert!(inventory_complete);
    assert!(home.runners_dir().join("live-runner").exists());
    assert!(handle.remove_if_current().await.unwrap());
}

#[tokio::test]
async fn invalid_managed_live_base_dir_fails_closed() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    create_managed_resources(&home, "orphan-bin", "live-runner", old_mtime(1_000_000));
    let runner_dir = home.runners_dir().join("live-runner");
    let handle = crate::live_runner_instances::publish(
        &home,
        LiveRunnerInstanceMetadata {
            config_path: runner_dir.join(RUNNER_CONFIG_NAME),
            base_dir: runner_dir.join("nested"),
            runner_group: "test".to_string(),
            subcommand: "start".to_string(),
        },
    )
    .await
    .unwrap();

    let outcome = gc_managed_resources(
        &home,
        (&[], &[]),
        &BTreeSet::new(),
        &BTreeSet::new(),
        &BTreeSet::new(),
        Some(0),
        false,
    )
    .await
    .unwrap();
    let (report, retained_config_paths, inventory_complete) = outcome.into_parts();

    assert!(report.is_empty());
    assert!(retained_config_paths.is_empty());
    assert!(!inventory_complete);
    assert!(home.bin_dir().join("orphan-bin").exists());
    assert!(home.runners_dir().join("live-runner").exists());
    assert!(handle.remove_if_current().await.unwrap());
}

#[tokio::test]
async fn symlinked_managed_root_makes_inventory_incomplete() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    std::fs::create_dir_all(dir.path().join("outside")).unwrap();
    std::fs::create_dir_all(home.bin_dir().parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(dir.path().join("outside"), home.bin_dir()).unwrap();

    let outcome = gc_managed_resources(
        &home,
        (&[], &[]),
        &BTreeSet::new(),
        &BTreeSet::new(),
        &BTreeSet::new(),
        Some(0),
        false,
    )
    .await
    .unwrap();
    let (report, _, inventory_complete) = outcome.into_parts();

    assert!(report.is_empty());
    assert!(!inventory_complete);
    assert!(dir.path().join("outside").exists());
}

#[tokio::test]
async fn installed_service_discovery_is_sorted_and_ignores_unrelated_entries() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("vm0-runner-production-z.service"), "").unwrap();
    std::fs::write(dir.path().join("vm0-runner-production-a.service"), "").unwrap();
    std::fs::write(dir.path().join("unrelated.service"), "").unwrap();

    let inventory = discover_installed_service_suffixes(dir.path()).await;

    assert_eq!(
        inventory.suffixes,
        ["production-a".to_string(), "production-z".to_string()]
    );
    assert!(inventory.complete);
}

#[tokio::test]
async fn invalid_installed_runner_service_makes_inventory_incomplete() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("vm0-runner-production.service"), "").unwrap();
    std::fs::write(dir.path().join("vm0-runner-UPPER.service"), "").unwrap();

    let inventory = discover_installed_service_suffixes(dir.path()).await;

    assert_eq!(inventory.suffixes, ["production".to_string()]);
    assert!(!inventory.complete);
}

#[tokio::test]
async fn unrelated_non_utf8_service_entry_does_not_invalidate_inventory() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("vm0-runner-production.service"), "").unwrap();
    std::fs::write(
        dir.path().join(std::ffi::OsString::from_vec(
            b"unrelated-\xff.service".to_vec(),
        )),
        "",
    )
    .unwrap();

    let inventory = discover_installed_service_suffixes(dir.path()).await;

    assert_eq!(inventory.suffixes, ["production".to_string()]);
    assert!(inventory.complete);
}

#[tokio::test]
async fn matching_non_utf8_runner_service_entry_makes_inventory_incomplete() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join(std::ffi::OsString::from_vec(
            b"vm0-runner-production-\xff.service".to_vec(),
        )),
        "",
    )
    .unwrap();

    let inventory = discover_installed_service_suffixes(dir.path()).await;

    assert!(inventory.suffixes.is_empty());
    assert!(!inventory.complete);
}

#[tokio::test]
async fn installed_service_iteration_failure_makes_inventory_incomplete() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("vm0-runner-production.service"), "").unwrap();
    let mut entry_reader = GcDirEntryReader::failing_after(0);

    let inventory =
        discover_installed_service_suffixes_with_reader(dir.path(), &mut entry_reader).await;

    assert!(inventory.suffixes.is_empty());
    assert!(!inventory.complete);
}

#[tokio::test]
async fn direct_config_service_resolves_independent_opaque_names() {
    let dir = tempfile::tempdir().unwrap();
    install_fake_systemctl(dir.path());
    let home = HomePaths::with_root(dir.path().join("home"));
    create_managed_resources(
        &home,
        "binary-opaque",
        "config-opaque",
        old_mtime(1_000_000),
    );

    run_systemctl_scenario(dir.path(), &home, "direct").await;

    let invocations = std::fs::read_to_string(dir.path().join("invocations")).unwrap();
    assert!(!invocations.contains("deployment-source-config"));
    assert_eq!(invocations.matches("--no-pager cat --").count(), 1);
    assert_eq!(
        invocations
            .matches("show vm0-runner-service-blue.service")
            .count(),
        2
    );
}

#[tokio::test]
async fn activation_snapshot_resolves_its_parent_runner_directory() {
    let dir = tempfile::tempdir().unwrap();
    install_fake_systemctl(dir.path());
    let home = HomePaths::with_root(dir.path().join("home"));
    create_managed_resources(
        &home,
        "binary-opaque",
        "config-opaque",
        old_mtime(1_000_000),
    );
    let runner_dir = home.runners_dir().join("config-opaque");
    let snapshot_path = runner_dir
        .join(SERVICE_CONFIG_SNAPSHOT_DIR)
        .join(format!("service-blue-{SNAPSHOT_DIGEST}.yaml"));
    write_config(&snapshot_path, &runner_dir);
    set_tree_mtime(&runner_dir, old_mtime(1_000_000));

    run_systemctl_scenario(dir.path(), &home, "snapshot").await;
}

#[tokio::test]
async fn external_activation_config_can_resolve_an_exact_managed_base_dir() {
    let dir = tempfile::tempdir().unwrap();
    install_fake_systemctl(dir.path());
    let home = HomePaths::with_root(dir.path().join("home"));
    create_managed_resources(
        &home,
        "binary-opaque",
        "config-opaque",
        old_mtime(1_000_000),
    );
    let external_config = home
        .bin_dir()
        .parent()
        .unwrap()
        .join("operator/runner.yaml");
    write_config(&external_config, &home.runners_dir().join("config-opaque"));
    set_tree_mtime(external_config.parent().unwrap(), old_mtime(1_000_000));

    run_systemctl_scenario(dir.path(), &home, "external-config").await;

    assert!(external_config.exists());
}

#[tokio::test]
async fn external_config_with_invalid_managed_base_dir_fails_closed() {
    let dir = tempfile::tempdir().unwrap();
    install_fake_systemctl(dir.path());
    let home = HomePaths::with_root(dir.path().join("home"));
    create_managed_resources(
        &home,
        "binary-opaque",
        "config-opaque",
        old_mtime(1_000_000),
    );
    let external_config = home
        .bin_dir()
        .parent()
        .unwrap()
        .join("operator/runner.yaml");
    write_config(
        &external_config,
        &home.runners_dir().join("config-opaque/nested"),
    );
    set_tree_mtime(external_config.parent().unwrap(), old_mtime(1_000_000));

    run_systemctl_scenario(dir.path(), &home, "invalid-base-dir").await;
}

#[tokio::test]
async fn invalid_activation_snapshot_name_fails_closed() {
    let dir = tempfile::tempdir().unwrap();
    install_fake_systemctl(dir.path());
    let home = HomePaths::with_root(dir.path().join("home"));
    create_managed_resources(
        &home,
        "binary-opaque",
        "config-opaque",
        old_mtime(1_000_000),
    );
    let runner_dir = home.runners_dir().join("config-opaque");
    let snapshot_path = runner_dir
        .join(SERVICE_CONFIG_SNAPSHOT_DIR)
        .join(format!("other-{SNAPSHOT_DIGEST}.yaml"));
    write_config(&snapshot_path, &runner_dir);
    set_tree_mtime(&runner_dir, old_mtime(1_000_000));

    run_systemctl_scenario(dir.path(), &home, "invalid-snapshot").await;
}

#[tokio::test]
async fn explicit_service_keep_retains_its_exact_resolved_resources() {
    let dir = tempfile::tempdir().unwrap();
    install_fake_systemctl(dir.path());
    let home = HomePaths::with_root(dir.path().join("home"));
    create_managed_resources(
        &home,
        "binary-opaque",
        "config-opaque",
        old_mtime(1_000_000),
    );

    run_systemctl_scenario(dir.path(), &home, "keep-service").await;
}

#[tokio::test]
async fn loaded_transient_service_is_reference_only() {
    let dir = tempfile::tempdir().unwrap();
    install_fake_systemctl(dir.path());
    let home = HomePaths::with_root(dir.path().join("home"));
    create_managed_resources(
        &home,
        "binary-opaque",
        "config-opaque",
        old_mtime(1_000_000),
    );

    run_systemctl_scenario(dir.path(), &home, "transient").await;
}

#[tokio::test]
async fn active_persistent_service_retains_paths_shared_with_a_removed_service() {
    let dir = tempfile::tempdir().unwrap();
    install_fake_systemctl(dir.path());
    let home = HomePaths::with_root(dir.path().join("home"));
    create_managed_resources(&home, "shared-bin", "shared-runner", old_mtime(1_000_000));

    run_systemctl_scenario(dir.path(), &home, "shared").await;
}

#[tokio::test]
async fn uninstall_failure_keeps_service_resources_for_retry() {
    let dir = tempfile::tempdir().unwrap();
    install_fake_systemctl(dir.path());
    let home = HomePaths::with_root(dir.path().join("home"));
    create_managed_resources(
        &home,
        "binary-opaque",
        "config-opaque",
        old_mtime(1_000_000),
    );

    run_systemctl_scenario(dir.path(), &home, "uninstall-failure").await;
}

#[tokio::test]
async fn directory_removal_failure_preserves_image_inventory_for_retry() {
    let dir = tempfile::tempdir().unwrap();
    install_fake_systemctl(dir.path());
    let home = HomePaths::with_root(dir.path().join("home"));
    create_managed_resources(
        &home,
        "binary-opaque",
        "config-opaque",
        old_mtime(1_000_000),
    );

    run_systemctl_scenario(dir.path(), &home, "remove-failure").await;
}

#[tokio::test]
async fn directories_that_become_recent_after_inventory_are_retained() {
    let dir = tempfile::tempdir().unwrap();
    install_fake_systemctl(dir.path());
    let home = HomePaths::with_root(dir.path().join("home"));
    create_managed_resources(
        &home,
        "binary-opaque",
        "config-opaque",
        old_mtime(1_000_000),
    );

    run_systemctl_scenario(dir.path(), &home, "becomes-recent").await;
}

#[tokio::test]
async fn external_executable_does_not_claim_a_managed_binary() {
    let dir = tempfile::tempdir().unwrap();
    install_fake_systemctl(dir.path());
    let home = HomePaths::with_root(dir.path().join("home"));
    create_managed_resources(&home, "unregistered", "config-opaque", old_mtime(1_000_000));

    run_systemctl_scenario(dir.path(), &home, "external-executable").await;
}

#[tokio::test]
async fn invalid_managed_executable_layout_makes_inventory_incomplete() {
    let dir = tempfile::tempdir().unwrap();
    install_fake_systemctl(dir.path());
    let home = HomePaths::with_root(dir.path().join("home"));
    create_managed_resources(
        &home,
        "binary-opaque",
        "config-opaque",
        old_mtime(1_000_000),
    );

    run_systemctl_scenario(dir.path(), &home, "invalid-managed-executable").await;
}

#[tokio::test]
#[ignore = "spawned by managed resource GC systemctl tests"]
async fn managed_resource_gc_systemctl_child() {
    let Ok(scenario) = std::env::var(DEPLOYMENT_SCENARIO_ENV) else {
        return;
    };
    if !ignored_child_test_env_guard_enabled((DEPLOYMENT_SCENARIO_ENV, &scenario)) {
        return;
    }
    let home = HomePaths::with_root(PathBuf::from(std::env::var(DEPLOYMENT_HOME_ENV).unwrap()));
    let persistent = ["service-blue".to_string()];
    let empty = BTreeSet::new();

    match scenario.as_str() {
        "direct" | "snapshot" | "external-config" => {
            let outcome = gc_managed_resources(
                &home,
                (&persistent, &[]),
                &empty,
                &empty,
                &empty,
                Some(0),
                false,
            )
            .await
            .unwrap();
            let (report, retained_config_paths, inventory_complete) = outcome.into_parts();

            assert_eq!(report.activity_count, 3);
            assert!(retained_config_paths.is_empty());
            assert!(inventory_complete);
            assert!(!home.bin_dir().join("binary-opaque").exists());
            assert!(!home.runners_dir().join("config-opaque").exists());
        }
        "external-executable" => {
            let outcome = gc_managed_resources(
                &home,
                (&persistent, &[]),
                &empty,
                &empty,
                &empty,
                Some(0),
                false,
            )
            .await
            .unwrap();
            let (report, retained_config_paths, inventory_complete) = outcome.into_parts();

            assert_eq!(report.activity_count, 3);
            assert!(retained_config_paths.is_empty());
            assert!(inventory_complete);
            assert!(!home.bin_dir().join("unregistered").exists());
            assert!(!home.runners_dir().join("config-opaque").exists());
        }
        "invalid-snapshot" | "invalid-base-dir" | "invalid-managed-executable" => {
            let outcome = gc_managed_resources(
                &home,
                (&persistent, &[]),
                &empty,
                &empty,
                &empty,
                Some(0),
                false,
            )
            .await
            .unwrap();
            let (report, retained_config_paths, inventory_complete) = outcome.into_parts();

            assert!(report.is_empty());
            assert!(retained_config_paths.is_empty());
            assert!(!inventory_complete);
            assert!(home.runners_dir().join("config-opaque").exists());
        }
        "keep-service" => {
            let unit = service::RunnerServiceUnit::from_suffix("service-blue").unwrap();
            let outcome = gc_managed_resources(
                &home,
                (&persistent, &[]),
                &BTreeSet::from(["service-blue".to_string()]),
                &empty,
                &empty,
                Some(0),
                false,
            )
            .await
            .unwrap();
            let (report, retained_config_paths, inventory_complete) = outcome.into_parts();

            assert!(report.is_empty());
            assert_eq!(
                retained_config_paths,
                [home.runners_dir().join("config-opaque/runner.yaml")]
            );
            assert!(inventory_complete);
            assert!(home.bin_dir().join("binary-opaque").exists());
            assert!(home.runners_dir().join("config-opaque").exists());
            assert!(unit.lock_path(&home).exists());
        }
        "transient" => {
            let unit = service::RunnerServiceUnit::from_suffix("service-blue").unwrap();
            let outcome = gc_managed_resources_with_operations(
                &home,
                ManagedResourceGcRequest {
                    persistent_service_suffixes: &[],
                    reference_only_service_suffixes: &persistent,
                    keep_service_suffixes: &empty,
                    keep_bin_dirnames: &empty,
                    keep_runner_dirnames: &empty,
                    keep_latest: Some(0),
                    service_inventory_complete: true,
                    dry_run: false,
                },
                ManagedResourceGcOperations {
                    uninstall_service: unexpected_fake_uninstall_service_unit,
                    remove_dir_all: real_remove_dir_all,
                },
            )
            .await
            .unwrap();
            let (report, retained_config_paths, inventory_complete) = outcome.into_parts();

            assert!(report.is_empty());
            assert_eq!(
                retained_config_paths,
                [home.runners_dir().join("config-opaque/runner.yaml")]
            );
            assert!(inventory_complete);
            assert!(home.bin_dir().join("binary-opaque").exists());
            assert!(home.runners_dir().join("config-opaque").exists());
            assert!(unit.lock_path(&home).exists());
        }
        "shared" => {
            let persistent = ["service-a".to_string(), "service-z".to_string()];
            let service_a = service::RunnerServiceUnit::from_suffix("service-a").unwrap();
            let service_z = service::RunnerServiceUnit::from_suffix("service-z").unwrap();
            let outcome = gc_managed_resources(
                &home,
                (&persistent, &[]),
                &empty,
                &empty,
                &empty,
                Some(0),
                false,
            )
            .await
            .unwrap();
            let (report, retained_config_paths, inventory_complete) = outcome.into_parts();

            assert_eq!(report.activity_count, 1);
            assert_eq!(
                retained_config_paths,
                [home.runners_dir().join("shared-runner/runner.yaml")]
            );
            assert!(inventory_complete);
            assert!(home.bin_dir().join("shared-bin").exists());
            assert!(home.runners_dir().join("shared-runner").exists());
            assert!(service_a.lock_path(&home).exists());
            assert!(!service_z.lock_path(&home).exists());
        }
        "uninstall-failure" => {
            let unit = service::RunnerServiceUnit::from_suffix("service-blue").unwrap();
            let outcome = gc_managed_resources_with_operations(
                &home,
                ManagedResourceGcRequest {
                    persistent_service_suffixes: &persistent,
                    reference_only_service_suffixes: &[],
                    keep_service_suffixes: &empty,
                    keep_bin_dirnames: &empty,
                    keep_runner_dirnames: &empty,
                    keep_latest: Some(0),
                    service_inventory_complete: true,
                    dry_run: false,
                },
                ManagedResourceGcOperations {
                    uninstall_service: failing_fake_uninstall_service_unit,
                    remove_dir_all: real_remove_dir_all,
                },
            )
            .await
            .unwrap();
            let (report, retained_config_paths, inventory_complete) = outcome.into_parts();

            assert!(report.is_empty());
            assert_eq!(
                retained_config_paths,
                [home.runners_dir().join("config-opaque/runner.yaml")]
            );
            assert!(inventory_complete);
            assert!(home.bin_dir().join("binary-opaque").exists());
            assert!(home.runners_dir().join("config-opaque").exists());
            assert!(unit.lock_path(&home).exists());
        }
        "remove-failure" => {
            let unit = service::RunnerServiceUnit::from_suffix("service-blue").unwrap();
            let outcome = gc_managed_resources_with_operations(
                &home,
                ManagedResourceGcRequest {
                    persistent_service_suffixes: &persistent,
                    reference_only_service_suffixes: &[],
                    keep_service_suffixes: &empty,
                    keep_bin_dirnames: &empty,
                    keep_runner_dirnames: &empty,
                    keep_latest: Some(0),
                    service_inventory_complete: true,
                    dry_run: false,
                },
                ManagedResourceGcOperations {
                    uninstall_service: successful_fake_uninstall_service_unit,
                    remove_dir_all: failing_remove_dir_all,
                },
            )
            .await
            .unwrap();
            let (report, retained_config_paths, inventory_complete) = outcome.into_parts();

            assert_eq!(report.activity_count, 1);
            assert_eq!(
                retained_config_paths,
                [home.runners_dir().join("config-opaque/runner.yaml")]
            );
            assert!(!inventory_complete);
            assert!(home.bin_dir().join("binary-opaque").exists());
            assert!(home.runners_dir().join("config-opaque").exists());
            assert!(!unit.lock_path(&home).exists());
        }
        "becomes-recent" => {
            let unit = service::RunnerServiceUnit::from_suffix("service-blue").unwrap();
            let outcome = gc_managed_resources_with_operations(
                &home,
                ManagedResourceGcRequest {
                    persistent_service_suffixes: &persistent,
                    reference_only_service_suffixes: &[],
                    keep_service_suffixes: &empty,
                    keep_bin_dirnames: &empty,
                    keep_runner_dirnames: &empty,
                    keep_latest: Some(0),
                    service_inventory_complete: true,
                    dry_run: false,
                },
                ManagedResourceGcOperations {
                    uninstall_service: touching_fake_uninstall_service_unit,
                    remove_dir_all: real_remove_dir_all,
                },
            )
            .await
            .unwrap();
            let (report, retained_config_paths, inventory_complete) = outcome.into_parts();

            assert_eq!(report.activity_count, 1);
            assert_eq!(
                retained_config_paths,
                [home.runners_dir().join("config-opaque/runner.yaml")]
            );
            assert!(inventory_complete);
            assert!(home.bin_dir().join("binary-opaque").exists());
            assert!(home.runners_dir().join("config-opaque").exists());
            assert!(!unit.lock_path(&home).exists());
        }
        unexpected => panic!("unexpected deployment scenario: {unexpected}"),
    }
}
