use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

use super::*;
use crate::test_fixtures::ignored_child::{
    ignored_child_test_env_guard_enabled, run_ignored_child_test,
};

const DEPLOYMENT_CHILD_TEST: &str =
    "cmd::gc::deployments::tests::installed_deployment_systemctl_child";
const DEPLOYMENT_SCENARIO_ENV: &str = "OKOU_RUN_GC_DEPLOYMENT_SCENARIO";
const DEPLOYMENT_HOME_ENV: &str = "OKOU_RUN_GC_DEPLOYMENT_HOME";
const DEPLOYMENT_INVOCATIONS_ENV: &str = "OKOU_RUN_GC_DEPLOYMENT_INVOCATIONS";
const FAKE_SYSTEMCTL: &str = r#"#!/bin/sh
printf '%s\n' "$*" >> "$OKOU_RUN_GC_DEPLOYMENT_INVOCATIONS"

if [ "$1" = "--no-pager" ] && [ "$2" = "cat" ] && [ "$3" = "--" ]; then
  case "$OKOU_RUN_GC_DEPLOYMENT_SCENARIO" in
    opaque-paths|keep-service|partial-runner-failure|uninstall-failure)
      binary_dirname=binary-opaque
      runner_dirname=config-opaque
      ;;
    keep-latest)
      suffix=${4#vm0-runner-}
      suffix=${suffix%.service}
      binary_dirname=${suffix}-bin
      runner_dirname=${suffix}-config
      ;;
    keep-roots)
      case "$4" in
        vm0-runner-service-a.service)
          binary_dirname=keep-bin
          runner_dirname=remove-runner
          ;;
        vm0-runner-service-z.service)
          binary_dirname=remove-bin
          runner_dirname=keep-runner
          ;;
      esac
      ;;
    shared-paths)
      binary_dirname=shared-bin
      runner_dirname=shared-runner
      ;;
    out-of-root)
      printf '%s\n' \
        '[Service]' \
        "ExecStart=$OKOU_RUN_GC_DEPLOYMENT_HOME/outside/runner start --config $OKOU_RUN_GC_DEPLOYMENT_HOME/runners/config-opaque/runner.yaml"
      exit 0
      ;;
    *)
      printf '%s\n' "unexpected deployment scenario: $OKOU_RUN_GC_DEPLOYMENT_SCENARIO" >&2
      exit 2
      ;;
  esac
  printf '%s\n' \
    '[Service]' \
    "ExecStart=$OKOU_RUN_GC_DEPLOYMENT_HOME/bin/$binary_dirname/runner start --config $OKOU_RUN_GC_DEPLOYMENT_HOME/runners/$runner_dirname/runner.yaml"
  exit 0
fi

if [ "$1" = "show" ]; then
  if [ "$OKOU_RUN_GC_DEPLOYMENT_SCENARIO" = "shared-paths" ] && \
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

fn failing_fake_uninstall_service_unit(
    _unit: &service::RunnerServiceUnit,
) -> ServiceUninstallFuture<'_> {
    Box::pin(async { Err(RunnerError::Internal("injected uninstall failure".into())) })
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

fn create_test_deployment(
    home_root: &Path,
    bin_dirname: &str,
    runner_dirname: &str,
    mtime: SystemTime,
) {
    let bin_dir = home_root.join("bin").join(bin_dirname);
    let runner_dir = home_root.join("runners").join(runner_dirname);
    std::fs::create_dir_all(&bin_dir).unwrap();
    std::fs::create_dir_all(&runner_dir).unwrap();
    std::fs::write(bin_dir.join("runner"), "runner").unwrap();
    std::fs::write(runner_dir.join("runner.yaml"), "profiles: {}\n").unwrap();
    for path in [
        bin_dir.clone(),
        bin_dir.join("runner"),
        runner_dir.clone(),
        runner_dir.join("runner.yaml"),
    ] {
        std::fs::File::open(path)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(mtime))
            .unwrap();
    }
}

async fn gc_discovered_deployments(
    home: &HomePaths,
    service_suffixes: &[String],
    keep_service_suffixes: &BTreeSet<String>,
    keep_bin_dirnames: &BTreeSet<String>,
    keep_runner_dirnames: &BTreeSet<String>,
    keep_latest: Option<usize>,
    dry_run: bool,
) -> RunnerResult<DeploymentGcOutcome> {
    gc_deployments_with_operations(
        home,
        DeploymentGcRequest {
            service_suffixes,
            keep_service_suffixes,
            keep_bin_dirnames,
            keep_runner_dirnames,
            keep_latest,
            service_inventory_complete: true,
            dry_run,
        },
        DeploymentGcOperations {
            uninstall_service: real_uninstall_service_unit,
            remove_dir_all: real_remove_dir_all,
        },
    )
    .await
}

#[tokio::test]
async fn busy_installed_service_lock_makes_the_complete_inventory_unavailable() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let unit = service::RunnerServiceUnit::from_suffix("service-blue").unwrap();
    let _held = crate::lock::acquire(unit.lock_path(&home)).await.unwrap();

    let outcome = gc_discovered_deployments(
        &home,
        &["service-blue".to_string()],
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
async fn symlinked_managed_root_makes_inventory_incomplete() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    std::fs::create_dir_all(dir.path().join("outside")).unwrap();
    std::fs::create_dir_all(home.bin_dir().parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(dir.path().join("outside"), home.bin_dir()).unwrap();

    let outcome = gc_discovered_deployments(
        &home,
        &["service-blue".to_string()],
        &BTreeSet::new(),
        &BTreeSet::new(),
        &BTreeSet::new(),
        Some(0),
        true,
    )
    .await
    .unwrap();
    let (report, _, inventory_complete) = outcome.into_parts();

    assert!(report.is_empty());
    assert!(!inventory_complete);
    assert!(dir.path().join("outside").exists());
}

#[tokio::test]
async fn explicit_keeps_without_installed_services_retain_paths() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let keep = BTreeSet::from(["release-blue".to_string()]);

    let outcome = gc_discovered_deployments(&home, &[], &keep, &keep, &keep, Some(0), false)
        .await
        .unwrap();
    let (report, retained_config_paths, inventory_complete) = outcome.into_parts();

    assert!(report.is_empty());
    assert_eq!(
        retained_config_paths,
        [home.runners_dir().join("release-blue/runner.yaml")]
    );
    assert!(inventory_complete);
}

#[tokio::test]
async fn no_installed_services_leave_unregistered_semver_shaped_paths_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    create_test_deployment(dir.path(), "v1.2.3", "v1.2.3", old);

    let outcome = gc_discovered_deployments(
        &home,
        &[],
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
    assert!(inventory_complete);
    assert!(home.bin_dir().join("v1.2.3/runner").exists());
    assert!(home.runners_dir().join("v1.2.3/runner.yaml").exists());
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
async fn installed_service_resolves_independent_opaque_dirnames() {
    let dir = tempfile::tempdir().unwrap();
    install_fake_systemctl(dir.path());

    let home_root = dir.path().join("home");
    let old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    create_test_deployment(&home_root, "binary-opaque", "config-opaque", old);

    let invocations_path = dir.path().join("invocations");
    run_ignored_child_test(
        DEPLOYMENT_CHILD_TEST,
        (DEPLOYMENT_SCENARIO_ENV, "opaque-paths"),
        &[
            ("PATH", Some(dir.path().to_str().unwrap())),
            (DEPLOYMENT_HOME_ENV, Some(home_root.to_str().unwrap())),
            (
                DEPLOYMENT_INVOCATIONS_ENV,
                Some(invocations_path.to_str().unwrap()),
            ),
        ],
        Duration::from_secs(10),
    )
    .await;

    assert_eq!(
        std::fs::read_to_string(invocations_path)
            .unwrap()
            .lines()
            .collect::<Vec<_>>(),
        [
            "--no-pager cat -- vm0-runner-service-blue.service",
            "show vm0-runner-service-blue.service --property=LoadState --property=ActiveState",
            "show vm0-runner-service-blue.service --property=LoadState --property=ActiveState",
        ]
    );
}

#[tokio::test]
async fn keep_latest_retains_the_newest_installed_deployment_by_mtime() {
    let dir = tempfile::tempdir().unwrap();
    install_fake_systemctl(dir.path());
    let home_root = dir.path().join("home");
    create_test_deployment(
        &home_root,
        "service-a-bin",
        "service-a-config",
        SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000),
    );
    create_test_deployment(
        &home_root,
        "service-z-bin",
        "service-z-config",
        SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000),
    );

    let invocations_path = dir.path().join("invocations");
    run_ignored_child_test(
        DEPLOYMENT_CHILD_TEST,
        (DEPLOYMENT_SCENARIO_ENV, "keep-latest"),
        &[
            ("PATH", Some(dir.path().to_str().unwrap())),
            (DEPLOYMENT_HOME_ENV, Some(home_root.to_str().unwrap())),
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
async fn exact_keep_dirnames_apply_only_to_their_own_roots() {
    let dir = tempfile::tempdir().unwrap();
    install_fake_systemctl(dir.path());
    let home_root = dir.path().join("home");
    let old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    create_test_deployment(&home_root, "keep-bin", "remove-runner", old);
    create_test_deployment(&home_root, "remove-bin", "keep-runner", old);

    let invocations_path = dir.path().join("invocations");
    run_ignored_child_test(
        DEPLOYMENT_CHILD_TEST,
        (DEPLOYMENT_SCENARIO_ENV, "keep-roots"),
        &[
            ("PATH", Some(dir.path().to_str().unwrap())),
            (DEPLOYMENT_HOME_ENV, Some(home_root.to_str().unwrap())),
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
async fn exact_keep_service_suffix_retains_the_resolved_deployment() {
    let dir = tempfile::tempdir().unwrap();
    install_fake_systemctl(dir.path());
    let home_root = dir.path().join("home");
    let old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    create_test_deployment(&home_root, "binary-opaque", "config-opaque", old);

    let invocations_path = dir.path().join("invocations");
    run_ignored_child_test(
        DEPLOYMENT_CHILD_TEST,
        (DEPLOYMENT_SCENARIO_ENV, "keep-service"),
        &[
            ("PATH", Some(dir.path().to_str().unwrap())),
            (DEPLOYMENT_HOME_ENV, Some(home_root.to_str().unwrap())),
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
async fn shared_paths_are_retained_by_a_deactivating_deployment() {
    let dir = tempfile::tempdir().unwrap();
    install_fake_systemctl(dir.path());
    let home_root = dir.path().join("home");
    create_test_deployment(
        &home_root,
        "shared-bin",
        "shared-runner",
        SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000),
    );

    let invocations_path = dir.path().join("invocations");
    run_ignored_child_test(
        DEPLOYMENT_CHILD_TEST,
        (DEPLOYMENT_SCENARIO_ENV, "shared-paths"),
        &[
            ("PATH", Some(dir.path().to_str().unwrap())),
            (DEPLOYMENT_HOME_ENV, Some(home_root.to_str().unwrap())),
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
async fn partial_path_failure_retains_retry_authority_and_skips_image_gc() {
    let dir = tempfile::tempdir().unwrap();
    install_fake_systemctl(dir.path());
    let home_root = dir.path().join("home");
    create_test_deployment(
        &home_root,
        "binary-opaque",
        "config-opaque",
        SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000),
    );

    let invocations_path = dir.path().join("invocations");
    run_ignored_child_test(
        DEPLOYMENT_CHILD_TEST,
        (DEPLOYMENT_SCENARIO_ENV, "partial-runner-failure"),
        &[
            ("PATH", Some(dir.path().to_str().unwrap())),
            (DEPLOYMENT_HOME_ENV, Some(home_root.to_str().unwrap())),
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
async fn uninstall_failure_retains_lock_and_skips_image_gc() {
    let dir = tempfile::tempdir().unwrap();
    install_fake_systemctl(dir.path());
    let home_root = dir.path().join("home");
    create_test_deployment(
        &home_root,
        "binary-opaque",
        "config-opaque",
        SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000),
    );

    let invocations_path = dir.path().join("invocations");
    run_ignored_child_test(
        DEPLOYMENT_CHILD_TEST,
        (DEPLOYMENT_SCENARIO_ENV, "uninstall-failure"),
        &[
            ("PATH", Some(dir.path().to_str().unwrap())),
            (DEPLOYMENT_HOME_ENV, Some(home_root.to_str().unwrap())),
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
async fn out_of_root_unit_paths_make_the_inventory_incomplete() {
    let dir = tempfile::tempdir().unwrap();
    install_fake_systemctl(dir.path());
    let home_root = dir.path().join("home");
    std::fs::create_dir_all(home_root.join("bin/unregistered")).unwrap();
    std::fs::create_dir_all(home_root.join("runners/config-opaque")).unwrap();

    let invocations_path = dir.path().join("invocations");
    run_ignored_child_test(
        DEPLOYMENT_CHILD_TEST,
        (DEPLOYMENT_SCENARIO_ENV, "out-of-root"),
        &[
            ("PATH", Some(dir.path().to_str().unwrap())),
            (DEPLOYMENT_HOME_ENV, Some(home_root.to_str().unwrap())),
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
#[ignore = "spawned by installed deployment systemctl tests"]
async fn installed_deployment_systemctl_child() {
    let Ok(scenario) = std::env::var(DEPLOYMENT_SCENARIO_ENV) else {
        return;
    };
    if !ignored_child_test_env_guard_enabled((DEPLOYMENT_SCENARIO_ENV, &scenario)) {
        return;
    }
    let home = HomePaths::with_root(PathBuf::from(std::env::var(DEPLOYMENT_HOME_ENV).unwrap()));
    match scenario.as_str() {
        "opaque-paths" => {
            let outcome = gc_deployments_with_operations(
                &home,
                DeploymentGcRequest {
                    service_suffixes: &["service-blue".to_string()],
                    keep_service_suffixes: &BTreeSet::new(),
                    keep_bin_dirnames: &BTreeSet::new(),
                    keep_runner_dirnames: &BTreeSet::new(),
                    keep_latest: Some(0),
                    service_inventory_complete: true,
                    dry_run: false,
                },
                DeploymentGcOperations {
                    uninstall_service: successful_fake_uninstall_service_unit,
                    remove_dir_all: real_remove_dir_all,
                },
            )
            .await
            .unwrap();
            let (report, retained_config_paths, inventory_complete) = outcome.into_parts();

            assert_eq!(report.activity_count, 1);
            assert!(retained_config_paths.is_empty());
            assert!(inventory_complete);
            assert!(!home.bin_dir().join("binary-opaque").exists());
            assert!(!home.runners_dir().join("config-opaque").exists());
            assert!(
                !service::RunnerServiceUnit::from_suffix("service-blue")
                    .unwrap()
                    .lock_path(&home)
                    .exists()
            );
        }
        "keep-service" => {
            let unit = service::RunnerServiceUnit::from_suffix("service-blue").unwrap();
            let outcome = gc_deployments_with_operations(
                &home,
                DeploymentGcRequest {
                    service_suffixes: &["service-blue".to_string()],
                    keep_service_suffixes: &BTreeSet::from(["service-blue".to_string()]),
                    keep_bin_dirnames: &BTreeSet::new(),
                    keep_runner_dirnames: &BTreeSet::new(),
                    keep_latest: Some(0),
                    service_inventory_complete: true,
                    dry_run: false,
                },
                DeploymentGcOperations {
                    uninstall_service: successful_fake_uninstall_service_unit,
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
        "keep-latest" => {
            let outcome = gc_discovered_deployments(
                &home,
                &["service-a".to_string(), "service-z".to_string()],
                &BTreeSet::new(),
                &BTreeSet::new(),
                &BTreeSet::new(),
                Some(1),
                true,
            )
            .await
            .unwrap();
            let (report, retained_config_paths, inventory_complete) = outcome.into_parts();

            assert_eq!(report.activity_count, 1);
            assert_eq!(
                retained_config_paths,
                [home.runners_dir().join("service-z-config/runner.yaml")]
            );
            assert!(inventory_complete);
        }
        "keep-roots" => {
            let outcome = gc_deployments_with_operations(
                &home,
                DeploymentGcRequest {
                    service_suffixes: &["service-a".to_string(), "service-z".to_string()],
                    keep_service_suffixes: &BTreeSet::new(),
                    keep_bin_dirnames: &BTreeSet::from(["keep-bin".to_string()]),
                    keep_runner_dirnames: &BTreeSet::from(["keep-runner".to_string()]),
                    keep_latest: Some(0),
                    service_inventory_complete: true,
                    dry_run: false,
                },
                DeploymentGcOperations {
                    uninstall_service: successful_fake_uninstall_service_unit,
                    remove_dir_all: real_remove_dir_all,
                },
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
            assert!(!home.runners_dir().join("remove-runner").exists());
            assert!(!home.bin_dir().join("remove-bin").exists());
            assert!(home.runners_dir().join("keep-runner").exists());
        }
        "shared-paths" => {
            let service_a = service::RunnerServiceUnit::from_suffix("service-a").unwrap();
            let service_z = service::RunnerServiceUnit::from_suffix("service-z").unwrap();
            let outcome = gc_deployments_with_operations(
                &home,
                DeploymentGcRequest {
                    service_suffixes: &["service-a".to_string(), "service-z".to_string()],
                    keep_service_suffixes: &BTreeSet::new(),
                    keep_bin_dirnames: &BTreeSet::new(),
                    keep_runner_dirnames: &BTreeSet::new(),
                    keep_latest: Some(0),
                    service_inventory_complete: true,
                    dry_run: false,
                },
                DeploymentGcOperations {
                    uninstall_service: successful_fake_uninstall_service_unit,
                    remove_dir_all: real_remove_dir_all,
                },
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
        "partial-runner-failure" => {
            let unit = service::RunnerServiceUnit::from_suffix("service-blue").unwrap();
            let outcome = gc_deployments_with_operations(
                &home,
                DeploymentGcRequest {
                    service_suffixes: &["service-blue".to_string()],
                    keep_service_suffixes: &BTreeSet::new(),
                    keep_bin_dirnames: &BTreeSet::new(),
                    keep_runner_dirnames: &BTreeSet::new(),
                    keep_latest: Some(0),
                    service_inventory_complete: true,
                    dry_run: false,
                },
                DeploymentGcOperations {
                    uninstall_service: successful_fake_uninstall_service_unit,
                    remove_dir_all: failing_remove_dir_all,
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
            assert!(!inventory_complete);
            assert!(home.bin_dir().join("binary-opaque").exists());
            assert!(home.runners_dir().join("config-opaque").exists());
            assert!(unit.lock_path(&home).exists());
        }
        "uninstall-failure" => {
            let unit = service::RunnerServiceUnit::from_suffix("service-blue").unwrap();
            let outcome = gc_deployments_with_operations(
                &home,
                DeploymentGcRequest {
                    service_suffixes: &["service-blue".to_string()],
                    keep_service_suffixes: &BTreeSet::new(),
                    keep_bin_dirnames: &BTreeSet::new(),
                    keep_runner_dirnames: &BTreeSet::new(),
                    keep_latest: Some(0),
                    service_inventory_complete: true,
                    dry_run: false,
                },
                DeploymentGcOperations {
                    uninstall_service: failing_fake_uninstall_service_unit,
                    remove_dir_all: real_remove_dir_all,
                },
            )
            .await
            .unwrap();
            let (report, retained_config_paths, inventory_complete) = outcome.into_parts();

            assert!(report.is_empty());
            assert!(retained_config_paths.is_empty());
            assert!(!inventory_complete);
            assert!(!home.bin_dir().join("binary-opaque").exists());
            assert!(!home.runners_dir().join("config-opaque").exists());
            assert!(unit.lock_path(&home).exists());
        }
        "out-of-root" => {
            let outcome = gc_discovered_deployments(
                &home,
                &["service-blue".to_string()],
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
            assert!(home.bin_dir().join("unregistered").exists());
        }
        unexpected => panic!("unexpected deployment scenario: {unexpected}"),
    }
}
