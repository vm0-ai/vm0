use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::future::Future;
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::time::SystemTime;

use nix::fcntl::Flock;
use tracing::{info, warn};

use crate::cmd::service;
use crate::error::{RunnerError, RunnerResult};
use crate::lock;
use crate::paths::HomePaths;

use super::GC_MIN_AGE;
use super::filesystem::{GcDirStatus, gc_path_dir_status};
use super::lock_file::{ExistingLockProbe, probe_existing_lock, remove_unused_lock_after_probe};
use super::report::GcReport;

const RUNNER_BINARY_NAME: &str = "runner";
const RUNNER_CONFIG_NAME: &str = "runner.yaml";

type ServiceUninstallFuture<'a> = Pin<Box<dyn Future<Output = RunnerResult<()>> + 'a>>;
type ServiceUninstallFn = for<'a> fn(&'a service::RunnerServiceUnit) -> ServiceUninstallFuture<'a>;
type RemoveDirAllFuture<'a> = Pin<Box<dyn Future<Output = std::io::Result<()>> + 'a>>;
type RemoveDirAllFn = for<'a> fn(&'a Path) -> RemoveDirAllFuture<'a>;

fn real_uninstall_service_unit(unit: &service::RunnerServiceUnit) -> ServiceUninstallFuture<'_> {
    Box::pin(service::uninstall_service_unit(unit))
}

fn real_remove_dir_all(path: &Path) -> RemoveDirAllFuture<'_> {
    Box::pin(tokio::fs::remove_dir_all(path))
}

pub(super) struct DeploymentGcOutcome {
    report: GcReport,
    retained_config_paths: Vec<PathBuf>,
    image_inventory_complete: bool,
}

impl DeploymentGcOutcome {
    pub(super) fn into_parts(self) -> (GcReport, Vec<PathBuf>, bool) {
        (
            self.report,
            self.retained_config_paths,
            self.image_inventory_complete,
        )
    }
}

struct Deployment {
    unit: service::RunnerServiceUnit,
    bin_dir: PathBuf,
    runner_dir: PathBuf,
    config_path: PathBuf,
    newest_mtime: SystemTime,
    retain_record: bool,
}

struct LockedUnit {
    unit: service::RunnerServiceUnit,
    lock: Option<Flock<std::fs::File>>,
}

struct DeploymentGcRequest<'a> {
    service_suffixes: &'a [String],
    keep_bin_dirnames: &'a BTreeSet<String>,
    keep_runner_dirnames: &'a BTreeSet<String>,
    keep_latest: Option<usize>,
    legacy_inventory_missing: bool,
    dry_run: bool,
}

struct DeploymentGcOperations {
    uninstall_service: ServiceUninstallFn,
    remove_dir_all: RemoveDirAllFn,
}

pub(super) async fn gc_deployments(
    home: &HomePaths,
    service_suffixes: &[String],
    keep_bin_dirnames: &BTreeSet<String>,
    keep_runner_dirnames: &BTreeSet<String>,
    keep_latest: Option<usize>,
    legacy_inventory_missing: bool,
    dry_run: bool,
) -> RunnerResult<DeploymentGcOutcome> {
    gc_deployments_with_operations(
        home,
        DeploymentGcRequest {
            service_suffixes,
            keep_bin_dirnames,
            keep_runner_dirnames,
            keep_latest,
            legacy_inventory_missing,
            dry_run,
        },
        DeploymentGcOperations {
            uninstall_service: real_uninstall_service_unit,
            remove_dir_all: real_remove_dir_all,
        },
    )
    .await
}

async fn gc_deployments_with_operations(
    home: &HomePaths,
    request: DeploymentGcRequest<'_>,
    operations: DeploymentGcOperations,
) -> RunnerResult<DeploymentGcOutcome> {
    let DeploymentGcRequest {
        service_suffixes,
        keep_bin_dirnames,
        keep_runner_dirnames,
        keep_latest,
        legacy_inventory_missing,
        dry_run,
    } = request;
    let DeploymentGcOperations {
        uninstall_service,
        remove_dir_all,
    } = operations;
    validate_dirnames("--keep-bin-dirname", keep_bin_dirnames)?;
    validate_dirnames("--keep-runner-dirname", keep_runner_dirnames)?;

    let explicit_config_paths = keep_runner_dirnames
        .iter()
        .map(|dirname| home.runners_dir().join(dirname).join(RUNNER_CONFIG_NAME))
        .collect::<Vec<_>>();

    let units = validated_units(service_suffixes)?;
    if units.is_empty() {
        if legacy_inventory_missing {
            warn!(
                "runner deployments: legacy --protect-version did not provide deployment service inventory; skipping image GC"
            );
        }
        return Ok(DeploymentGcOutcome {
            report: GcReport::default(),
            retained_config_paths: explicit_config_paths,
            image_inventory_complete: !legacy_inventory_missing,
        });
    }
    if !managed_roots_are_safe(home).await {
        return Ok(incomplete_outcome());
    }

    let locked_units = match lock_complete_inventory(home, units, dry_run).await {
        Some(locked_units) => locked_units,
        None => return Ok(incomplete_outcome()),
    };

    let mut deployments = Vec::with_capacity(locked_units.len());
    for locked in &locked_units {
        let command_paths = match service::read_unit_command_paths(&locked.unit).await {
            Ok(Some(paths)) => paths,
            Ok(None) => {
                warn!(
                    "runner deployment {}: effective ExecStart does not contain parseable runner paths; retaining all deployments",
                    locked.unit.suffix()
                );
                return Ok(incomplete_outcome());
            }
            Err(error) => {
                warn!(
                    "runner deployment {}: cannot read effective ExecStart ({error}); retaining all deployments",
                    locked.unit.suffix()
                );
                return Ok(incomplete_outcome());
            }
        };

        let Some(bin_dirname) = managed_dirname(
            command_paths.executable_path(),
            &home.bin_dir(),
            RUNNER_BINARY_NAME,
        ) else {
            warn!(
                "runner deployment {}: executable {} is outside the managed binary layout; retaining all deployments",
                locked.unit.suffix(),
                command_paths.executable_path().display()
            );
            return Ok(incomplete_outcome());
        };
        let Some(runner_dirname) = managed_dirname(
            command_paths.config_path(),
            &home.runners_dir(),
            RUNNER_CONFIG_NAME,
        ) else {
            warn!(
                "runner deployment {}: config {} is outside the managed runner layout; retaining all deployments",
                locked.unit.suffix(),
                command_paths.config_path().display()
            );
            return Ok(incomplete_outcome());
        };

        let bin_dir = home.bin_dir().join(&bin_dirname);
        let runner_dir = home.runners_dir().join(&runner_dirname);
        if !managed_paths_are_safe(
            locked.unit.suffix(),
            &bin_dir,
            command_paths.executable_path(),
            &runner_dir,
            command_paths.config_path(),
        )
        .await
        {
            return Ok(incomplete_outcome());
        }

        let deployment_mtime =
            newest_mtime([command_paths.executable_path(), command_paths.config_path()])
                .await
                .max(newest_mtime([home.bin_dir().join(&bin_dirname), runner_dir.clone()]).await);
        deployments.push(Deployment {
            unit: locked.unit.clone(),
            bin_dir,
            runner_dir,
            config_path: command_paths.config_path().to_path_buf(),
            newest_mtime: deployment_mtime,
            retain_record: false,
        });
    }

    if !mark_active_deployments(&mut deployments).await {
        return Ok(incomplete_outcome());
    }
    mark_recent_deployments(&mut deployments);
    mark_latest_deployments(&mut deployments, keep_latest.unwrap_or(0));

    let mut retained_bin_dirs = keep_bin_dirnames
        .iter()
        .map(|dirname| home.bin_dir().join(dirname))
        .collect::<HashSet<_>>();
    let mut retained_runner_dirs = keep_runner_dirnames
        .iter()
        .map(|dirname| home.runners_dir().join(dirname))
        .collect::<HashSet<_>>();
    for deployment in &deployments {
        if deployment.retain_record {
            retained_bin_dirs.insert(deployment.bin_dir.clone());
            retained_runner_dirs.insert(deployment.runner_dir.clone());
        }
    }

    // The complete candidate lock set stays held through this final activity
    // check and every mutation, preventing install/uninstall from changing the
    // exact ownership graph after it has authorized deletion.
    if !mark_newly_active_deployments(
        &mut deployments,
        &mut retained_bin_dirs,
        &mut retained_runner_dirs,
    )
    .await
    {
        return Ok(incomplete_outcome());
    }

    let mut failed_paths = HashSet::new();
    let mut removed_runner_dirs = HashSet::new();

    for runner_dir in unique_paths(deployments.iter().map(|item| &item.runner_dir)) {
        if retained_runner_dirs.contains(&runner_dir) {
            continue;
        }
        if remove_managed_dir(&runner_dir, dry_run, remove_dir_all).await {
            removed_runner_dirs.insert(runner_dir);
        } else {
            failed_paths.insert(runner_dir);
        }
    }
    let bin_dirs_blocked_by_runner_failure = deployments
        .iter()
        .filter(|deployment| failed_paths.contains(&deployment.runner_dir))
        .map(|deployment| deployment.bin_dir.clone())
        .collect::<HashSet<_>>();
    for bin_dir in unique_paths(deployments.iter().map(|item| &item.bin_dir)) {
        if retained_bin_dirs.contains(&bin_dir)
            || bin_dirs_blocked_by_runner_failure.contains(&bin_dir)
        {
            continue;
        }
        if !remove_managed_dir(&bin_dir, dry_run, remove_dir_all).await {
            failed_paths.insert(bin_dir);
        }
    }

    let locks_by_suffix = locked_units
        .iter()
        .map(|locked| (locked.unit.suffix(), locked.lock.as_ref()))
        .collect::<BTreeMap<_, _>>();
    let mut removed = Vec::new();
    for deployment in &deployments {
        if deployment.retain_record
            || failed_paths.contains(&deployment.bin_dir)
            || failed_paths.contains(&deployment.runner_dir)
        {
            continue;
        }

        if dry_run {
            info!(
                "[dry-run] would remove runner deployment {}",
                deployment.unit.suffix()
            );
        } else {
            if let Err(error) = uninstall_service(&deployment.unit).await {
                warn!(
                    "runner deployment {}: cannot uninstall service safely ({error}); leaving its unit and lock for retry",
                    deployment.unit.suffix()
                );
                continue;
            }
            let lock_path = deployment.unit.lock_path(home);
            let Some(Some(service_lock)) = locks_by_suffix.get(deployment.unit.suffix()) else {
                warn!(
                    "runner deployment {}: acquired service lock is missing after uninstall",
                    deployment.unit.suffix()
                );
                continue;
            };
            remove_unused_lock_after_probe(
                &lock_path,
                service_lock,
                deployment.unit.lock_file_name(),
                false,
            )
            .await;
        }
        removed.push(deployment.unit.suffix().to_string());
    }

    let mut retained_config_paths = explicit_config_paths;
    for deployment in &deployments {
        if !removed_runner_dirs.contains(&deployment.runner_dir) {
            retained_config_paths.push(deployment.config_path.clone());
        }
    }
    retained_config_paths.sort();
    retained_config_paths.dedup();

    Ok(DeploymentGcOutcome {
        report: GcReport::removed_deployments(removed),
        retained_config_paths,
        image_inventory_complete: true,
    })
}

fn incomplete_outcome() -> DeploymentGcOutcome {
    DeploymentGcOutcome {
        report: GcReport::default(),
        retained_config_paths: Vec::new(),
        image_inventory_complete: false,
    }
}

fn validate_dirnames(flag: &str, dirnames: &BTreeSet<String>) -> RunnerResult<()> {
    for dirname in dirnames {
        if !crate::runner_dirname::validate_name(dirname) {
            return Err(RunnerError::Config(format!(
                "invalid {flag} value {}: {}",
                crate::runner_dirname::invalid_name_diagnostic(dirname),
                crate::runner_dirname::validation_rules()
            )));
        }
    }
    Ok(())
}

fn validated_units(service_suffixes: &[String]) -> RunnerResult<Vec<service::RunnerServiceUnit>> {
    let mut units = BTreeMap::new();
    for suffix in service_suffixes {
        let unit = service::RunnerServiceUnit::from_suffix(suffix)?;
        units.entry(suffix.clone()).or_insert(unit);
    }
    Ok(units.into_values().collect())
}

async fn lock_complete_inventory(
    home: &HomePaths,
    units: Vec<service::RunnerServiceUnit>,
    dry_run: bool,
) -> Option<Vec<LockedUnit>> {
    let mut locked_units = Vec::with_capacity(units.len());
    for unit in units {
        let lock_path = unit.lock_path(home);
        let lock = if dry_run {
            match probe_existing_lock(&lock_path) {
                ExistingLockProbe::Free(lock) => Some(lock),
                ExistingLockProbe::Missing => None,
                ExistingLockProbe::Held => {
                    info!(
                        "runner deployment {}: service lock held; retaining all deployments",
                        unit.suffix()
                    );
                    return None;
                }
                ExistingLockProbe::Error(error) => {
                    warn!(
                        "runner deployment {}: cannot probe service lock ({error}); retaining all deployments",
                        unit.suffix()
                    );
                    return None;
                }
            }
        } else {
            match lock::try_acquire_or_busy(lock_path).await {
                Ok(lock::TryLock::Acquired(lock)) => Some(lock),
                Ok(lock::TryLock::Busy) => {
                    info!(
                        "runner deployment {}: service lock held; retaining all deployments",
                        unit.suffix()
                    );
                    return None;
                }
                Err(error) => {
                    warn!(
                        "runner deployment {}: cannot acquire service lock ({error}); retaining all deployments",
                        unit.suffix()
                    );
                    return None;
                }
            }
        };
        locked_units.push(LockedUnit { unit, lock });
    }
    Some(locked_units)
}

fn managed_dirname(path: &Path, root: &Path, expected_file_name: &str) -> Option<String> {
    if !path.is_absolute() {
        return None;
    }
    let relative = path.strip_prefix(root).ok()?;
    let mut components = relative.components();
    let Component::Normal(dirname) = components.next()? else {
        return None;
    };
    let Component::Normal(file_name) = components.next()? else {
        return None;
    };
    if components.next().is_some() || file_name != expected_file_name {
        return None;
    }
    let dirname = dirname.to_str()?;
    crate::runner_dirname::validate_name(dirname).then(|| dirname.to_string())
}

async fn managed_roots_are_safe(home: &HomePaths) -> bool {
    for (label, root) in [("binary", home.bin_dir()), ("runner", home.runners_dir())] {
        match gc_path_dir_status(&root).await {
            Ok(GcDirStatus::RealDir(_) | GcDirStatus::Missing) => {}
            Ok(GcDirStatus::NotDirectory) => {
                warn!(
                    "runner deployments: managed {label} root {} is not a directory; retaining all deployments",
                    root.display()
                );
                return false;
            }
            Err(error) => {
                warn!(
                    "runner deployments: cannot inspect managed {label} root {} ({error}); retaining all deployments",
                    root.display()
                );
                return false;
            }
        }
    }
    true
}

async fn managed_paths_are_safe(
    suffix: &str,
    bin_dir: &Path,
    executable_path: &Path,
    runner_dir: &Path,
    config_path: &Path,
) -> bool {
    for (label, path) in [("binary", bin_dir), ("runner", runner_dir)] {
        match gc_path_dir_status(path).await {
            Ok(GcDirStatus::RealDir(_) | GcDirStatus::Missing) => {}
            Ok(GcDirStatus::NotDirectory) => {
                warn!(
                    "runner deployment {suffix}: managed {label} path {} is not a directory; retaining all deployments",
                    path.display()
                );
                return false;
            }
            Err(error) => {
                warn!(
                    "runner deployment {suffix}: cannot inspect managed {label} path {} ({error}); retaining all deployments",
                    path.display()
                );
                return false;
            }
        }
    }
    for (label, path) in [("executable", executable_path), ("config", config_path)] {
        match tokio::fs::symlink_metadata(path).await {
            Ok(metadata) if metadata.file_type().is_file() => {}
            Ok(_) => {
                warn!(
                    "runner deployment {suffix}: managed {label} path {} is not a regular file; retaining all deployments",
                    path.display()
                );
                return false;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                warn!(
                    "runner deployment {suffix}: cannot inspect managed {label} path {} ({error}); retaining all deployments",
                    path.display()
                );
                return false;
            }
        }
    }
    true
}

async fn newest_mtime<const N: usize>(paths: [impl AsRef<Path>; N]) -> SystemTime {
    let mut newest = SystemTime::UNIX_EPOCH;
    for path in paths {
        if let Ok(metadata) = tokio::fs::symlink_metadata(path.as_ref()).await
            && let Ok(mtime) = metadata.modified()
        {
            newest = newest.max(mtime);
        }
    }
    newest
}

async fn mark_active_deployments(deployments: &mut [Deployment]) -> bool {
    for deployment in deployments {
        match service::cleanup_unit_is_active(&deployment.unit).await {
            Ok(active) => deployment.retain_record |= active,
            Err(error) => {
                warn!(
                    "runner deployment {}: cannot check service activity ({error}); retaining all deployments",
                    deployment.unit.suffix()
                );
                return false;
            }
        }
    }
    true
}

fn mark_recent_deployments(deployments: &mut [Deployment]) {
    let now = SystemTime::now();
    for deployment in deployments {
        let age = now
            .duration_since(deployment.newest_mtime)
            .unwrap_or_default();
        deployment.retain_record |= age < GC_MIN_AGE;
    }
}

fn mark_latest_deployments(deployments: &mut [Deployment], keep_count: usize) {
    if keep_count == 0 {
        return;
    }
    let mut sorted = deployments.iter().enumerate().collect::<Vec<_>>();
    sorted.sort_by(|(_, left), (_, right)| {
        right
            .newest_mtime
            .cmp(&left.newest_mtime)
            .then_with(|| left.unit.suffix().cmp(right.unit.suffix()))
    });
    let retained_indices = sorted
        .into_iter()
        .take(keep_count)
        .map(|(index, _)| index)
        .collect::<HashSet<_>>();
    for (index, deployment) in deployments.iter_mut().enumerate() {
        deployment.retain_record |= retained_indices.contains(&index);
    }
}

async fn mark_newly_active_deployments(
    deployments: &mut [Deployment],
    retained_bin_dirs: &mut HashSet<PathBuf>,
    retained_runner_dirs: &mut HashSet<PathBuf>,
) -> bool {
    for deployment in deployments {
        match service::cleanup_unit_is_active(&deployment.unit).await {
            Ok(true) => {
                deployment.retain_record = true;
                retained_bin_dirs.insert(deployment.bin_dir.clone());
                retained_runner_dirs.insert(deployment.runner_dir.clone());
            }
            Ok(false) => {}
            Err(error) => {
                warn!(
                    "runner deployment {}: cannot recheck service activity ({error}); retaining all deployments",
                    deployment.unit.suffix()
                );
                return false;
            }
        }
    }
    true
}

fn unique_paths<'a>(paths: impl Iterator<Item = &'a PathBuf>) -> BTreeSet<PathBuf> {
    paths.cloned().collect()
}

async fn remove_managed_dir(path: &Path, dry_run: bool, remove_dir_all: RemoveDirAllFn) -> bool {
    if dry_run {
        info!(
            "[dry-run] would remove managed runner directory {}",
            path.display()
        );
        return true;
    }
    match remove_dir_all(path).await {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(error) => {
            warn!("cannot remove {}: {error}", path.display());
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;
    use std::time::Duration;

    use super::*;
    use crate::test_fixtures::ignored_child::{
        ignored_child_test_env_guard_enabled, run_ignored_child_test,
    };

    const DEPLOYMENT_CHILD_TEST: &str =
        "cmd::gc::deployments::tests::explicit_deployment_systemctl_child";
    const DEPLOYMENT_SCENARIO_ENV: &str = "OKOU_RUN_GC_DEPLOYMENT_SCENARIO";
    const DEPLOYMENT_HOME_ENV: &str = "OKOU_RUN_GC_DEPLOYMENT_HOME";
    const DEPLOYMENT_INVOCATIONS_ENV: &str = "OKOU_RUN_GC_DEPLOYMENT_INVOCATIONS";
    const FAKE_SYSTEMCTL: &str = r#"#!/bin/sh
printf '%s\n' "$*" >> "$OKOU_RUN_GC_DEPLOYMENT_INVOCATIONS"

if [ "$1" = "--no-pager" ] && [ "$2" = "cat" ] && [ "$3" = "--" ]; then
  case "$OKOU_RUN_GC_DEPLOYMENT_SCENARIO" in
    opaque-paths)
      binary_dirname=binary-opaque
      runner_dirname=config-opaque
      ;;
    keep-latest)
      suffix=${4#vm0-runner-}
      suffix=${suffix%.service}
      binary_dirname=${suffix}-bin
      runner_dirname=${suffix}-config
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

    #[tokio::test]
    async fn busy_candidate_lock_makes_the_complete_inventory_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let unit = service::RunnerServiceUnit::from_suffix("service-blue").unwrap();
        let _held = crate::lock::acquire(unit.lock_path(&home)).await.unwrap();

        let outcome = gc_deployments(
            &home,
            &["service-blue".to_string()],
            &BTreeSet::new(),
            &BTreeSet::new(),
            Some(0),
            false,
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

        let outcome = gc_deployments(
            &home,
            &["service-blue".to_string()],
            &BTreeSet::new(),
            &BTreeSet::new(),
            Some(0),
            false,
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
    async fn legacy_keep_without_candidates_retains_both_paths_and_skips_images() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let keep = BTreeSet::from(["release-blue".to_string()]);

        let outcome = gc_deployments(&home, &[], &keep, &keep, Some(0), true, false)
            .await
            .unwrap();
        let (report, retained_config_paths, inventory_complete) = outcome.into_parts();

        assert!(report.is_empty());
        assert_eq!(
            retained_config_paths,
            [home.runners_dir().join("release-blue/runner.yaml")]
        );
        assert!(!inventory_complete);
    }

    #[tokio::test]
    async fn explicit_service_suffix_resolves_independent_opaque_dirnames() {
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
    async fn keep_latest_retains_the_newest_explicit_deployment_by_mtime() {
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
    #[ignore = "spawned by explicit deployment systemctl tests"]
    async fn explicit_deployment_systemctl_child() {
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
                        keep_bin_dirnames: &BTreeSet::new(),
                        keep_runner_dirnames: &BTreeSet::new(),
                        keep_latest: Some(0),
                        legacy_inventory_missing: false,
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
            "keep-latest" => {
                let outcome = gc_deployments(
                    &home,
                    &["service-a".to_string(), "service-z".to_string()],
                    &BTreeSet::new(),
                    &BTreeSet::new(),
                    Some(1),
                    false,
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
            unexpected => panic!("unexpected deployment scenario: {unexpected}"),
        }
    }
}
